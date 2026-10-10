import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_PIXEL_ERROR_BODY_BYTES = 4096;
const pixelErrorLogPath = path.resolve(__dirname, "public", "pixel_error.log");
const diagnosticLogDir = path.resolve(__dirname, "public");

function sendPixelErrorResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

function pixelErrorLogger() {
  return {
    name: "pixel-error-logger",
    configureServer(server: { middlewares: { use: (handler: (
      request: IncomingMessage,
      response: ServerResponse,
      next: () => void,
    ) => void) => void } }) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

        if (request.method === "GET" && (pathname === "/pixel_error" || pathname === "/pixel_error.log")) {
          void readFile(pixelErrorLogPath, "utf8")
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "";
              throw error;
            })
            .then((contents) => sendPixelErrorResponse(response, 200, contents))
            .catch((error: unknown) => {
              console.error("[pixel-error-logger] failed to read log:", error);
              sendPixelErrorResponse(response, 500, "Failed to read log\n");
            });
          return;
        }

        if (request.method === "POST" && pathname === "/pixel-error-test/start") {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const file = `pixel_error_${stamp}.log`;
          void writeFile(path.resolve(diagnosticLogDir, file), "", "utf8")
            .then(() => {
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(JSON.stringify({ file }));
            })
            .catch((error: unknown) => {
              console.error("[pixel-error-logger] failed to create diagnostic log:", error);
              sendPixelErrorResponse(response, 500, "Failed to create diagnostic log\n");
            });
          return;
        }

        if (request.method === "POST" && pathname === "/pixel-error-test/entry") {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => { body += chunk; });
          request.on("end", () => {
            void (async () => {
              const parsed = JSON.parse(body) as { file?: string; result?: {
                tx: number; ty: number; ex: number; ey: number; err: number; n: number;
              } };
              if (!parsed.file || !parsed.result || !/^pixel_error_[\w.-]+\.log$/.test(parsed.file)) {
                sendPixelErrorResponse(response, 400, "Invalid diagnostic log entry\n");
                return;
              }
              const r = parsed.result;
              const line = [
                `target=(${r.tx.toFixed(6)},${r.ty.toFixed(6)})`,
                `predicted=(${r.ex.toFixed(6)},${r.ey.toFixed(6)})`,
                `error=${Number.isFinite(r.err) ? r.err.toFixed(6) : "unavailable"}`,
                `samples=${r.n}`,
              ].join(" ") + "\n";
              await appendFile(path.resolve(diagnosticLogDir, parsed.file), line, "utf8");
              sendPixelErrorResponse(response, 204, "");
            })().catch((error: unknown) => {
              console.error("[pixel-error-logger] failed to write diagnostic entry:", error);
              sendPixelErrorResponse(response, 500, "Failed to write diagnostic entry\n");
            });
          });
          return;
        }

        if (request.method !== "POST" || pathname !== "/pixel-error") {
          next();
          return;
        }

        let body = "";
        let bodyBytes = 0;
        let rejected = false;
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          bodyBytes += Buffer.byteLength(chunk);
          if (bodyBytes > MAX_PIXEL_ERROR_BODY_BYTES) {
            rejected = true;
            request.destroy();
            return;
          }
          body += chunk;
        });
        request.on("end", () => {
          if (rejected || !body.trim()) {
            sendPixelErrorResponse(response, 400, "Invalid log entry\n");
            return;
          }
          void mkdir(path.dirname(pixelErrorLogPath), { recursive: true })
            .then(() => appendFile(
              pixelErrorLogPath,
              body.endsWith("\n") ? body : `${body}\n`,
              "utf8",
            ))
            .then(() => sendPixelErrorResponse(response, 204, ""))
            .catch((error: unknown) => {
              console.error("[pixel-error-logger] failed to write log:", error);
              sendPixelErrorResponse(response, 500, "Failed to write log\n");
            });
        });
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), pixelErrorLogger()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  optimizeDeps: { exclude: ["@mediapipe/tasks-vision"] },
  build: { target: "esnext", chunkSizeWarningLimit: 2000 },
  test: { environment: "jsdom", globals: true },
});
