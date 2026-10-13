import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real npm start HTTP bridge preserves a bodyless collection POST", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "youth-inn-http-"));
  const child = spawn("npm", ["start"], { env: { ...process.env, STATE_DIRECTORY: directory, PORT: "0", HOST: "127.0.0.1",
    APP_SECRET: "unit-test-secret-with-at-least-32-bytes", BREVO_API_KEY: "", MAIL_FROM: "", ENABLE_MONITORING: "false", DISABLE_COLLECTION: "true" },
    stdio: ["ignore", "pipe", "pipe"], detached: true });
  let closed; const closing = new Promise((resolve)=>{closed=resolve;}); child.on("close",closed);
  // Signal the Node child via the process group so npm cannot orphan the listener.
  let origin;
  try {
    origin = await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("local server did not start")),5000); let buffer="";
      child.stdout.on("data",chunk=>{buffer+=chunk;const found=buffer.match(/已启动: (http:\/\/127\.0\.0\.1:\d+)/);if(found){clearTimeout(timer);resolve(found[1]);}});
      child.on("error",reject); child.stderr.on("data",()=>{});
    });
    const response = await fetch(`${origin}/api/collection`, { method: "POST" });
    assert.equal(response.status, 200); assert.equal((await response.json()).status, "idle");
    assert.equal((await fetch(`${origin}/api/collection`, { method: "POST", body: "{}" })).status, 400);
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  } finally {
    try { process.kill(-child.pid,"SIGTERM"); } catch {}
    await closing; await rm(directory,{recursive:true,force:true});
  }
});
