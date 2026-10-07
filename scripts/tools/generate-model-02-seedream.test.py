#!/usr/bin/env python3
"""Fault tests inject providers; no network or paid generation is permitted."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE_FILE = Path(__file__).with_name("generate-model-02-seedream.py")
spec = importlib.util.spec_from_file_location("seedream_utility", MODULE_FILE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="seedream-receipt-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.posts = 0
        self.keys = 0
        self.payload = {"model": module.MODEL, "prompt": "完整的原始文本", "size": "2K",
                        "output_format": "jpeg", "response_format": "url", "watermark": False}
        self.options = dict(receipt_root=self.root / "private", project="P1", angle="front",
                            payload=self.payload, output=self.root / "first.jpg",
                            key_supplier=self.key, submit=self.submit)

    def key(self):
        self.keys += 1
        return "test-only-key-never-persisted"

    def accepted(self):
        return {"model": module.MODEL, "created": 1791367500,
                "data": [{"url": "https://image.invalid/original.jpg", "size": "16x16", "output_format": "jpeg"}]}, 200, {"x-request-id": "test-request"}

    def submit(self, endpoint, payload, key):
        self.posts += 1
        self.assertEqual(endpoint, module.API_URL)
        self.assertEqual(payload, self.payload)
        self.assertEqual(key, "test-only-key-never-persisted")
        submitting = [json.loads(file.read_text()) for file in (self.root / "private").glob("*.json")
                      if json.loads(file.read_text())["state"] == "submitting"]
        self.assertEqual(len(submitting), 1)
        self.assertEqual(submitting[0]["identity"]["body"], self.payload)
        return self.accepted()

    def run_image(self, **changes):
        return module.resume_or_submit_image(**{**self.options, **changes})

    def test_acceptance_is_durable_before_download_and_keys_are_not_read_on_resume(self):
        result = self.run_image()
        file = next((self.root / "private").glob("*.json"))
        value = json.loads(file.read_text())
        self.assertEqual(value["state"], "accepted")
        self.assertEqual(value["response"], result[0])
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("test-only-key-never-persisted", file.read_text())
        self.assertEqual(self.run_image(output=self.root / "different-folder" / "another.jpg"), result)
        self.assertEqual((self.posts, self.keys), (1, 1))

    def test_unknown_ack_on_restart_never_submits_again(self):
        def lost(*_):
            self.posts += 1
            raise RuntimeError("response lost")
        with self.assertRaisesRegex(RuntimeError, "response lost"):
            self.run_image(submit=lost)
        with self.assertRaisesRegex(RuntimeError, "acceptance is unknown"):
            self.run_image()
        self.assertEqual((self.posts, self.keys), (1, 1))

    def test_lost_acceptance_journal_write_is_not_interpreted_as_no_charge(self):
        original_write = module.atomic_write
        def fail_acceptance(path, data):
            if path.suffix == ".json" and json.loads(data)["state"] == "accepted":
                raise OSError("disk write failed")
            return original_write(path, data)
        with patch.object(module, "atomic_write", fail_acceptance):
            with self.assertRaisesRegex(OSError, "disk write failed"):
                self.run_image()
        with self.assertRaisesRegex(RuntimeError, "acceptance is unknown"):
            self.run_image()
        self.assertEqual(self.posts, 1)

    def test_missing_credentials_never_reserves_or_submits_a_request(self):
        def missing():
            raise RuntimeError("credential unavailable")
        with self.assertRaisesRegex(RuntimeError, "credential unavailable"):
            self.run_image(key_supplier=missing)
        self.assertEqual(list((self.root / "private").glob("*.json")), [])
        self.assertEqual(self.posts, 0)

    def test_process_exit_before_ack_preserves_submitting_record(self):
        def crash(*_):
            self.posts += 1
            raise SystemExit("process died")
        with self.assertRaises(SystemExit):
            self.run_image(submit=crash)
        with self.assertRaisesRegex(RuntimeError, "acceptance is unknown"):
            self.run_image()
        self.assertEqual(self.posts, 1)
        self.assertEqual(json.loads(next((self.root / "private").glob("*.json")).read_text())["state"], "submitting")

    def test_malformed_or_rejected_ack_cannot_authorize_another_post(self):
        for index, response in enumerate([
            {"model": "wrong", "created": 1791367500, "data": [{"url": "https://image.invalid/one"}]},
            {"model": module.MODEL, "created": True, "data": [{"url": "https://image.invalid/one"}]},
            {"model": module.MODEL, "created": 1791367500, "data": []},
            {"model": module.MODEL, "created": 1791367500, "data": [{"url": "file:///unsafe"}]},
        ]):
            with self.subTest(index=index):
                angle = f"invalid-{index}"
                calls = []
                def malformed(*_):
                    calls.append(1)
                    return response, 200, {}
                with self.assertRaises(RuntimeError):
                    self.run_image(angle=angle, submit=malformed)
                with self.assertRaisesRegex(RuntimeError, "acceptance is unknown"):
                    self.run_image(angle=angle, submit=malformed)
                self.assertEqual(calls, [1])

    def test_same_slot_changed_body_or_model_refuses_and_different_slot_is_independent(self):
        self.run_image()
        with self.assertRaisesRegex(RuntimeError, "request changed"):
            self.run_image(payload={**self.payload, "prompt": "changed prompt"})
        with self.assertRaises(RuntimeError):
            self.run_image(payload={**self.payload, "model": "different-model"})
        self.run_image(angle="side")
        self.run_image(project="P2")
        self.assertEqual(self.posts, 3)

    def test_legacy_output_without_acceptance_is_not_regenerated(self):
        self.options["output"].write_bytes(b"existing paid artifact")
        with self.assertRaisesRegex(RuntimeError, "Legacy image"):
            self.run_image()
        self.assertEqual((self.posts, self.keys), (0, 0))

    def test_journal_tamper_corruption_and_symlinks_keep_original_evidence(self):
        self.run_image()
        file = next((self.root / "private").glob("*.json"))
        original = file.read_bytes()
        value = json.loads(original)
        value["identity"]["body"]["prompt"] = "tampered"
        file.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, "request changed"):
            self.run_image()
        file.write_bytes(b"invalid JSON")
        with self.assertRaisesRegex(RuntimeError, "Corrupt"):
            self.run_image()
        file.unlink()
        outside = self.root / "outside.json"
        outside.write_bytes(original)
        file.symlink_to(outside)
        with self.assertRaises(OSError):
            self.run_image()
        self.assertEqual(outside.read_bytes(), original)
        self.assertEqual(self.posts, 1)

    def test_invalid_scope_or_symlink_root_is_rejected_before_key_or_post(self):
        for value in ["", "../escape", "two\nlines", "x" * 129]:
            with self.assertRaises(RuntimeError):
                self.run_image(project=value)
        real = self.root / "real"
        real.mkdir()
        alias = self.root / "symlink"
        alias.symlink_to(real, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            self.run_image(receipt_root=alias)
        self.assertEqual((self.posts, self.keys), (0, 0))

    def test_live_lock_times_out_without_removing_another_owner_or_submitting(self):
        import fcntl
        self.run_image()
        lock = next((self.root / "private").glob("*.lock"))
        with lock.open("rb") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, "already in flight"):
                self.run_image(lock_timeout=0)
        self.assertTrue(lock.exists())
        self.assertEqual(self.posts, 1)

    def tiny_jpeg(self):
        ffmpeg = os.environ.get("WL_FFMPEG") or os.environ.get("FFMPEG_PATH") or "ffmpeg"
        made = subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16",
                               "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "-"],
                              capture_output=True, check=True, timeout=15)
        self.assertLess(len(made.stdout), 50 * 1024)
        return made.stdout

    def test_real_small_jpeg_is_decodable_without_a_quality_size_gate(self):
        module.validate_jpeg(self.tiny_jpeg())
        for invalid in [b"", b"not-an-image", b"\xff\xd8\xffcorrupt\xff\xd9"]:
            with self.assertRaises(RuntimeError):
                module.validate_jpeg(invalid)

    def test_main_download_failure_then_restart_restores_original_url_without_post(self):
        prompt = self.root / "prompt.txt"
        prompt.write_text(self.payload["prompt"])
        output = self.root / "delivered" / "front.jpg"
        argv = [str(MODULE_FILE), "--project", "P1", "--angle", "front", "--prompt-file", str(prompt),
                "--output", str(output), "--summary", "test portrait", "--receipt-root", str(self.root / "private")]
        urls = []
        def failed(url):
            urls.append(url)
            self.assertEqual(json.loads(next((self.root / "private").glob("*.json")).read_text())["state"], "accepted")
            raise RuntimeError("download failed")
        with patch.object(sys, "argv", argv), patch.object(module, "request_json", self.submit), patch.object(module, "key_from_local_store", self.key):
            with patch.object(module, "download_jpeg", failed):
                with self.assertRaisesRegex(RuntimeError, "download failed"):
                    module.main()
            with patch.object(module, "download_jpeg", lambda url: (urls.append(url) or self.tiny_jpeg(), 200, {})):
                self.assertEqual(module.main(), 0)
        self.assertEqual(urls, ["https://image.invalid/original.jpg"] * 2)
        self.assertEqual((self.posts, self.keys), (1, 1))
        self.assertTrue(output.exists())
        public = output.with_suffix(".jpg.provenance.json").read_text()
        self.assertNotIn("https://image.invalid/original.jpg", public)
        self.assertNotIn("test-only-key-never-persisted", public)

    def test_independent_processes_share_one_paid_ack_across_different_output_folders(self):
        count = self.root / "paid-count.txt"
        code = f'''import importlib.util,json,time
from pathlib import Path
s=importlib.util.spec_from_file_location("utility",{str(MODULE_FILE)!r}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
def submit(*args):
 with open({str(count)!r},"a") as f: f.write("1"); f.flush()
 time.sleep(0.1)
 return {{"model":m.MODEL,"created":1791367500,"data":[{{"url":"https://image.invalid/shared"}}]}},200,{{}}
result=m.resume_or_submit_image(receipt_root=Path({str(self.root / 'private')!r}),project="P1",angle="front",payload=json.loads({json.dumps(self.payload, ensure_ascii=False)!r}),output=Path(__import__("sys").argv[1]),key_supplier=lambda:"test",submit=submit)
print(result[3])
'''
        children = [subprocess.Popen([sys.executable, "-c", code, str(self.root / f"folder-{i}" / "image.jpg")],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(3)]
        try:
            results = [child.communicate(timeout=15) for child in children]
            for child, (out, error) in zip(children, results):
                self.assertEqual(child.returncode, 0, error)
                self.assertTrue(out.strip())
            self.assertEqual(len({out.strip() for out, _ in results}), 1)
            self.assertEqual(count.read_text(), "1")
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                    child.wait()


if __name__ == "__main__":
    unittest.main(verbosity=2)
