import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { findAvailable, findCalendar, findNearest } from "./src/service.mjs";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(projectRoot, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(payload));
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicRoot, requested));
  if (!filePath.startsWith(`${publicRoot}${sep}`)) {
    sendJson(response, 403, { error: "禁止访问" });
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: "页面不存在" });
      return;
    }
    sendJson(response, 500, { error: "读取页面失败" });
  }
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

async function handleApi(response, url) {
  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "youth-inn-finder" });
    return;
  }
  if (url.pathname === "/api/nearest") {
    const items = await findNearest(queryObject(url));
    sendJson(response, 200, { data: items });
    return;
  }
  if (url.pathname === "/api/available") {
    const result = await findAvailable(queryObject(url));
    sendJson(response, 200, {
      data: result.items,
      meta: { date: result.startDate, endDate: result.endDate },
    });
    return;
  }
  if (url.pathname === "/api/calendar") {
    const result = await findCalendar(queryObject(url));
    sendJson(response, 200, result);
    return;
  }
  sendJson(response, 404, { error: "API 不存在" });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }
  try {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "只支持 GET" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(response, 400, { error: error.message || "请求失败" });
  }
});

server.listen(port, host, () => {
  console.log(`青年驿站网页已启动: http://${host}:${port}`);
});
