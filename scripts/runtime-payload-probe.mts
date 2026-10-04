/** Import closure + real contracts from a physically copied customer payload. No network/DB calls. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
if(process.env.WORKLOOM_RUNTIME_PREFLIGHT!=="1") throw new Error("Preflight requires an isolated host");
globalThis.fetch=async()=>{throw new Error("PREFLIGHT_NETWORK_FORBIDDEN");};
const {normalizeFilmJobRequest,assertFilmStageCoverage}=await import("@hyperreality/video-studio");
const film=normalizeFilmJobRequest(["deliver"],{fps:24});
if(JSON.stringify(film.stages)!==JSON.stringify(["deliver","master"])||film.options.fps!=="24")
  throw new Error("Fixed film stage policy contract failed");
try {
  normalizeFilmJobRequest(["unregistered-worker"],{});
  throw new Error("Unknown film stage was accepted");
} catch(error) {if((error as {code?:string}).code!=="UNKNOWN_STAGE") throw error;}
try {
  assertFilmStageCoverage(["spec"],{}, {}, []);
  throw new Error("A missing film stage result was accepted");
} catch(error) {if((error as {code?:string}).code!=="RESULT_INVALID") throw error;}
const require=createRequire(path.join(root,"package.json"));
require(path.join(root,"vendor/supermickey/hyperreality-system/index.js"));
require(path.join(root,"vendor/supermickey/systems/llm-reasoning-engine.js"));
const {appRouter}=await import("../apps/server/src/trpc/router.js");
if(!appRouter) throw new Error("Server router unavailable");
const {loadProductRuntime}=await import("./product-runtime.mjs");
const identity=loadProductRuntime(root);
const product=JSON.parse(await readFile(path.join(root,"product.manifest.json"),"utf8"));
if(typeof product.defaultBundle!=="string"||!/^[a-z0-9][a-z0-9-]+$/u.test(product.defaultBundle)) throw new Error("Default bundle identity invalid");
const {composeWorkforce}=await import("@workloom/base/bundles");
const workforce=composeWorkforce(product.defaultBundle,path.join(root,"bundles"));
if(!workforce.presets.size) throw new Error("Verified product workforce is empty");
const {loadCatalog}=await import("./agent-capabilities.mjs");
const catalog=await loadCatalog();if(!catalog) throw new Error("Agent catalog unavailable");
for(const capability of ["core.task.dispatch","core.task.receipt","core.task.artifact","video.film.start","video.film.receipt"])
  if(!catalog.entries.has(capability)) throw new Error(`Agent execution catalog missing ${capability}`);
const caller=appRouter.createCaller({session:null,identity:null,partnerIdentity:null,headers:new Headers()});
try {
  await caller.agent.taskDispatch({title:"Isolation probe",idempotencyKey:"preflight-probe-key"});
  throw new Error("Unauthenticated execution was accepted");
} catch(error) {if((error as {code?:string}).code!=="UNAUTHORIZED") throw error;}
console.log("RUNTIME_PREFLIGHT "+JSON.stringify({status:"passed",platform:process.platform,arch:process.arch,
  productId:identity.productId,demoWorkspaceSlug:identity.demoWorkspaceSlug,demoMemberNo:identity.demoMemberNo,
  checks:["physical-internal-package","fixed-film-stage-policy","vendor-import","server-router-import","verified-bundle-composition","agent-catalog","agent-execution-auth","complete-product-identity"],networkCalls:0}));
