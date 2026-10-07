#!/usr/bin/env python3
"""Generate one original model-02 portrait through Ark Seedream text-to-image.

No image input is accepted by this tool. The API key stays in process memory;
the saved evidence omits the time-limited image URL and authentication headers.
"""

from __future__ import annotations

import argparse
import datetime
import fcntl
import hashlib
import json
import os
import re
import stat
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
MODEL = "doubao-seedream-5-0-pro-260628"
TRACE_HEADERS = (
    "x-tt-logid",
    "x-request-id",
    "x-trace-id",
    "x-ark-trace-id",
    "request-id",
)
JOURNAL_SCHEMA = "workloom.model-02-seedream-receipt/v1"
MAX_JOURNAL_BYTES = 8 * 1024 * 1024


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def key_from_local_store() -> str:
    for name in ("VOLCENGINE_ARK_API_KEY", "ARK_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "workloom-live-ark", "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError("Ark API key unavailable in environment or macOS Keychain")
    return result.stdout.strip()


def selected_headers(headers: object) -> dict[str, str]:
    return {name: value for name in TRACE_HEADERS if (value := headers.get(name))}


def request_json(url: str, payload: dict[str, object], api_key: str) -> tuple[dict[str, object], int, dict[str, str]]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            status = response.status
            trace = selected_headers(response.headers)
            raw = response.read(MAX_JOURNAL_BYTES + 1)
    except urllib.error.HTTPError as exc:
        detail = exc.read(4096).decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Ark HTTP {exc.code}; trace={selected_headers(exc.headers)}; body={detail}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Ark network error: {exc.reason}") from exc
    if len(raw) > MAX_JOURNAL_BYTES:
        raise RuntimeError("Ark response exceeded the receipt size limit; acceptance is unknown")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Ark returned invalid JSON (HTTP {status})") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("Ark response root is not an object")
    return parsed, status, trace


def download_jpeg(url: str) -> tuple[bytes, int, dict[str, str]]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise RuntimeError("Ark returned a non-HTTPS image URL")
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            status = response.status
            trace = selected_headers(response.headers)
            content_type = response.headers.get("Content-Type", "")
            data = response.read(32 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Image download HTTP {exc.code}; trace={selected_headers(exc.headers)}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Image download network error: {exc.reason}") from exc
    validate_jpeg(data, content_type)
    return data, status, trace


def validate_jpeg(data: bytes, content_type: str = "image/jpeg") -> None:
    """Verify executable media bytes without a minimum size or aesthetic quality gate."""
    if len(data) > 32 * 1024 * 1024:
        raise RuntimeError(f"Image exceeds the download byte limit: {len(data)}")
    if not data.startswith(b"\xff\xd8\xff") or not data.endswith(b"\xff\xd9"):
        raise RuntimeError(f"Image is not a complete JPEG (content-type={content_type})")
    binary = os.environ.get("WL_FFMPEG") or os.environ.get("FFMPEG_PATH") or "ffmpeg"
    try:
        decoded = subprocess.run([binary, "-v", "error", "-xerror", "-err_detect", "explode",
                                  "-f", "mjpeg", "-i", "pipe:0", "-frames:v", "1", "-f", "null", "-"],
                                 input=data, capture_output=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("JPEG decoding could not execute") from exc
    if decoded.returncode:
        raise RuntimeError("JPEG bytes could not be decoded")


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as temporary:
            temp_path = Path(temporary.name)
            temporary.write(data)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temp_path, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def image_response_url(response: object, model: str) -> str:
    if not isinstance(response, dict) or response.get("model") != model:
        raise RuntimeError("Unexpected Ark model in image acknowledgement")
    created = response.get("created")
    images = response.get("data")
    if isinstance(created, bool) or not isinstance(created, int) or created <= 0:
        raise RuntimeError("Image acknowledgement omitted its creation time")
    if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
        raise RuntimeError("Ark did not acknowledge exactly one image")
    url = images[0].get("url")
    if not isinstance(url, str):
        raise RuntimeError("Image acknowledgement omitted its URL")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise RuntimeError("Image acknowledgement has no usable HTTPS URL")
    return url


def default_receipt_root() -> Path:
    artifact = os.environ.get("WORKLOOM_VIDEO_ARTIFACT_ROOT")
    repository = Path(__file__).resolve().parents[2]
    return Path(artifact or repository) / "output" / "generation-receipts" / "model-02-seedream"


def resume_or_submit_image(*, receipt_root: Path, project: str, angle: str, payload: dict[str, object],
                           output: Path, key_supplier=None, submit=None, lock_timeout: float = 240
                           ) -> tuple[dict[str, object], int, dict[str, str], str]:
    """A durable slot journal saves acceptance before GET; unknown acceptance never authorizes a second POST."""
    if any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value)
           or ".." in value for value in (project, angle)):
        raise RuntimeError("Image project/angle scope is invalid")
    if not isinstance(payload, dict) or payload.get("model") != MODEL or "image" in payload or "images" in payload:
        raise RuntimeError("This utility only accepts its registered pure text-to-image model")
    compiled = json.loads(canonical(payload))
    key_supplier = key_supplier or key_from_local_store
    submit = submit or request_json
    if not isinstance(lock_timeout, (int, float)) or not 0 <= lock_timeout <= 3600:
        raise RuntimeError("Invalid image receipt lock timeout")
    identity = {"provider": "ark", "endpoint": API_URL, "method": "POST", "project": project, "angle": angle, "body": compiled}
    request_hash = sha256(canonical(identity).encode("utf-8"))
    slot_hash = sha256(canonical({"project": project, "angle": angle}).encode("utf-8"))
    root = Path(os.path.abspath(receipt_root))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not stat.S_ISDIR(root.lstat().st_mode) or root.is_symlink():
        raise RuntimeError("Image receipt root must be a real private directory")
    real_root = root.resolve()

    def check_root() -> None:
        if root.is_symlink() or not stat.S_ISDIR(root.lstat().st_mode) or root.resolve() != real_root:
            raise RuntimeError("Image receipt root changed during execution")

    receipt_file = root / f"{slot_hash}.json"

    def load() -> dict[str, object] | None:
        check_root()
        try:
            fd = os.open(receipt_file, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_JOURNAL_BYTES:
                raise RuntimeError("Invalid image receipt file; do not submit again")
            with os.fdopen(os.dup(fd), "rb") as stream:
                raw = stream.read(MAX_JOURNAL_BYTES + 1)
        finally:
            os.close(fd)
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError) as exc:
            raise RuntimeError("Corrupt image receipt; do not submit again") from exc
        if not isinstance(value, dict) or value.get("schemaVersion") != JOURNAL_SCHEMA:
            raise RuntimeError("Unrecognized image receipt; do not submit again")
        if value.get("requestSha256") != request_hash or canonical(value.get("identity")) != canonical(identity):
            raise RuntimeError("Image request changed in the same slot; do not submit again")
        if value.get("state") not in ("submitting", "accepted", "unknown"):
            raise RuntimeError("Invalid image receipt state; do not submit again")
        if value["state"] == "accepted":
            image_response_url(value.get("response"), MODEL)
            if not isinstance(value.get("httpStatus"), int) or not 200 <= value["httpStatus"] < 300:
                raise RuntimeError("Invalid accepted image HTTP receipt")
            trace = value.get("traceHeaders")
            if not isinstance(trace, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in trace.items()):
                raise RuntimeError("Invalid accepted image trace receipt")
        return value

    def save(value: dict[str, object]) -> None:
        check_root()
        if receipt_file.is_symlink():
            raise RuntimeError("Image receipt cannot replace a symbolic link")
        encoded = (canonical(value) + "\n").encode("utf-8")
        if len(encoded) > MAX_JOURNAL_BYTES:
            raise RuntimeError("Image receipt exceeded the byte limit")
        atomic_write(receipt_file, encoded)
        check_root()

    check_root()
    # Keep this lock inode forever: unlinking a flock file can admit two concurrent owners.
    lock_fd = os.open(root / f"{slot_hash}.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            raise RuntimeError("Image receipt lock is not a regular file")
        deadline = time.monotonic() + lock_timeout
        while True:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Image request is already in flight; no automatic paid POST")
                time.sleep(0.05)
        check_root()
        existing = load()
        if existing is not None:
            if existing["state"] != "accepted":
                raise RuntimeError("Image acceptance is unknown; no automatic paid POST")
            return existing["response"], existing["httpStatus"], existing["traceHeaders"], request_hash
        if output.exists() or output.is_symlink() or output.with_suffix(output.suffix + ".provenance.json").exists():
            raise RuntimeError("Legacy image artifact has no provider acceptance receipt; no automatic paid POST")
        # Missing credentials are established before reserving a request which never reached the provider.
        key = key_supplier()
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        receipt = {"schemaVersion": JOURNAL_SCHEMA, "identity": identity, "requestSha256": request_hash,
                   "state": "submitting", "createdAt": at, "updatedAt": at}
        save(receipt)
        try:
            response, status, trace = submit(API_URL, json.loads(canonical(compiled)), key)
            image_response_url(response, MODEL)
            if not isinstance(status, int) or not 200 <= status < 300:
                raise RuntimeError("Ark did not return a successful image acknowledgement")
            if not isinstance(trace, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in trace.items()):
                raise RuntimeError("Image acknowledgement trace is invalid")
        except Exception as exc:
            receipt.update(state="unknown", failureKind=type(exc).__name__,
                           updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
            try:
                save(receipt)
            except Exception as journal_error:
                raise RuntimeError("Image submission and failure journaling failed; do not submit again") from journal_error
            raise
        receipt.update(state="accepted", response=response, httpStatus=status, traceHeaders=trace,
                       updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        save(receipt)  # Accepted URL is durable before any download or public provenance write.
        return response, status, trace, request_hash
    finally:
        os.close(lock_fd)  # Process death also releases flock; the submitting journal still forbids new payment.


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--angle", required=True)
    parser.add_argument("--project", default="model-02")
    parser.add_argument("--receipt-root", type=Path, default=default_receipt_root())
    parser.add_argument("--prompt-file", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--summary", required=True)
    args = parser.parse_args()
    if args.output.suffix.lower() not in (".jpg", ".jpeg"):
        parser.error("output must have a .jpg or .jpeg suffix")
    if args.output.exists():
        parser.error(f"refusing to overwrite existing output: {args.output}")
    prompt = args.prompt_file.read_text(encoding="utf-8").strip()
    if not prompt or len(prompt) > 1000:
        parser.error("prompt must contain 1-1000 characters")
    payload: dict[str, object] = {
        "model": MODEL,
        "prompt": prompt,
        "size": "2K",
        "output_format": "jpeg",
        "response_format": "url",
        "watermark": False,
    }
    # Keep this a pure text-to-image request, even when the CLI is extended.
    assert "image" not in payload and "images" not in payload
    response, status, trace, request_hash = resume_or_submit_image(receipt_root=args.receipt_root,
        project=args.project, angle=args.angle, payload=payload, output=args.output)
    response_model = response.get("model")
    created = response.get("created")
    image_list = response.get("data")
    image_url = image_response_url(response, MODEL)
    image_info = image_list[0]
    image_bytes, download_status, download_trace = download_jpeg(image_url)
    digest = sha256(image_bytes)
    produce_id = f"WL-GROWTH-M02-{args.angle.upper()}-{created}-{digest[:12].upper()}"
    evidence = {
        "schemaVersion": "workloom.model-02-seedream-provenance/v1",
        "source": "original-pure-text-to-image",
        "apiDocument": "https://docs.volcengine.com/docs/ark/image-generation-api?lang=en",
        "invisibleWatermarkDocument": "https://docs.volcengine.com/docs/ark/add-invisible-watermark-to-ai-generated-content?lang=zh",
        "angle": args.angle,
        "project": args.project,
        "generationReceipt": {"schemaVersion": JOURNAL_SCHEMA, "requestSha256": request_hash, "state": "accepted"},
        "promptSummary": args.summary,
        "prompt": prompt,
        "promptSha256": sha256(prompt.encode("utf-8")),
        "request": {"url": API_URL, "bodyWithoutPrompt": {k: v for k, v in payload.items() if k != "prompt"}, "imageFieldPresent": False},
        "response": {
            "httpStatus": status,
            "traceHeaders": trace,
            "model": response_model,
            "created": created,
            "fields": sorted(response.keys()),
            "imageSize": image_info.get("size"),
            "imageFormat": image_info.get("output_format"),
            "usage": response.get("usage"),
        },
        "download": {"httpStatus": download_status, "traceHeaders": download_trace, "urlSha256": sha256(image_url.encode("utf-8"))},
        "output": {"path": str(args.output), "bytes": len(image_bytes), "sha256": digest},
        "produceId": produce_id,
        "produceIdNote": "Client-defined resource mapping. This is not an Ark or Seedream task_id.",
        "visibleWatermarkRequested": False,
        "invisibleWatermark": {"status": "unverified", "reason": "Endpoint-level feature and JPEG metadata require separate verification"},
    }
    atomic_write(args.output, image_bytes)
    evidence_file = args.output.with_suffix(args.output.suffix + ".provenance.json")
    atomic_write(evidence_file, (json.dumps(evidence, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps({"output": str(args.output), "sha256": digest, "model": response_model, "created": created, "traceHeaders": trace, "produceId": produce_id, "provenance": str(evidence_file)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"generation failed: {error}", file=sys.stderr)
        sys.exit(1)
