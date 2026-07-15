/**
 * Watch TV Plus - Proxy HLS reforzado para Cloudflare Workers
 * Ruta compatible con tu plantilla:
 *   /proxy?url=URL&ref=REFERER&ua=USER_AGENT&origin=ORIGIN
 *
 * Funciones:
 * - Añade CORS.
 * - Sigue redirecciones.
 * - Reenvía Range para segmentos.
 * - Reescribe playlists HLS maestras y secundarias.
 * - Reescribe segmentos, llaves AES, mapas y pistas de audio/subtítulos.
 * - Admite Referer, Origin y User-Agent indicados por el M3U.
 */

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type, Authorization, Accept, Origin, Referer, User-Agent",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonError("Método no permitido", 405);
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== "/proxy") {
      return new Response(
        "Watch TV Plus HLS Proxy activo. Usa /proxy?url=https%3A%2F%2Fejemplo.com%2Fcanal.m3u8",
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const targetRaw = requestUrl.searchParams.get("url");
    if (!targetRaw) return jsonError("Falta el parámetro url", 400);

    let target;
    try {
      target = new URL(targetRaw);
    } catch {
      return jsonError("URL inválida", 400);
    }

    if (!/^https?:$/.test(target.protocol) || isBlockedHost(target.hostname)) {
      return jsonError("Destino no permitido", 403);
    }

    const ref = cleanHeader(requestUrl.searchParams.get("ref"));
    const ua = cleanHeader(requestUrl.searchParams.get("ua")) || DEFAULT_USER_AGENT;
    const explicitOrigin = cleanHeader(requestUrl.searchParams.get("origin"));

    const upstreamHeaders = new Headers();
    upstreamHeaders.set("Accept", request.headers.get("Accept") || "*/*");
    upstreamHeaders.set("User-Agent", ua);

    const range = request.headers.get("Range");
    if (range) upstreamHeaders.set("Range", range);

    const authorization = request.headers.get("Authorization");
    if (authorization) upstreamHeaders.set("Authorization", authorization);

    if (ref) upstreamHeaders.set("Referer", ref);
    if (explicitOrigin) {
      upstreamHeaders.set("Origin", explicitOrigin);
    } else if (ref) {
      try {
        upstreamHeaders.set("Origin", new URL(ref).origin);
      } catch {}
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
        cf: {
          cacheEverything: false,
          mirage: false,
          polish: "off",
        },
      });
    } catch (error) {
      return jsonError(`No se pudo conectar al servidor del canal: ${String(error && error.message || error)}`, 502);
    }

    if (!upstream.ok && upstream.status !== 206) {
      const details = await safeText(upstream);
      return jsonError(
        `El servidor del canal respondió HTTP ${upstream.status}${details ? `: ${details.slice(0, 180)}` : ""}`,
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    const responseHeaders = copyUsefulHeaders(upstream.headers);
    Object.entries(CORS_HEADERS).forEach(([key, value]) => responseHeaders.set(key, value));
    responseHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
    responseHeaders.set("X-Watch-TV-Plus-Proxy", "1");

    if (request.method === "HEAD") {
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }

    const contentType = (upstream.headers.get("Content-Type") || "").toLowerCase();
    const finalUrl = upstream.url || target.toString();
    const looksLikePlaylist =
      contentType.includes("mpegurl") ||
      contentType.includes("application/x-mpegurl") ||
      /\.m3u8(?:$|[?#])/i.test(finalUrl) ||
      /\.m3u8(?:$|[?#])/i.test(target.toString());

    if (looksLikePlaylist) {
      const playlistText = await upstream.text();
      const rewritten = rewriteHlsPlaylist(playlistText, finalUrl, requestUrl.origin, { ref, ua, origin: explicitOrigin });
      responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      responseHeaders.delete("Content-Length");
      responseHeaders.delete("Content-Encoding");
      return new Response(rewritten, { status: 200, headers: responseHeaders });
    }

    // Algunos proveedores entregan el .m3u8 como text/plain o sin Content-Type.
    // Inspeccionamos únicamente respuestas pequeñas para no cargar segmentos grandes en memoria.
    const contentLength = Number(upstream.headers.get("Content-Length") || 0);
    const mayBeTextManifest =
      contentType.includes("text/plain") ||
      contentType.includes("application/json") ||
      (!contentType && contentLength > 0 && contentLength <= 2_000_000);

    if (mayBeTextManifest && (!contentLength || contentLength <= 2_000_000)) {
      const body = await upstream.arrayBuffer();
      const prefix = new TextDecoder().decode(body.slice(0, 64)).replace(/^\uFEFF/, "").trimStart();
      if (prefix.startsWith("#EXTM3U")) {
        const playlistText = new TextDecoder().decode(body);
        const rewritten = rewriteHlsPlaylist(playlistText, finalUrl, requestUrl.origin, { ref, ua, origin: explicitOrigin });
        responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        responseHeaders.delete("Content-Length");
        responseHeaders.delete("Content-Encoding");
        return new Response(rewritten, { status: 200, headers: responseHeaders });
      }
      return new Response(body, { status: upstream.status, headers: responseHeaders });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  },
};

function rewriteHlsPlaylist(text, baseUrl, workerOrigin, context) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  if (!source.trimStart().startsWith("#EXTM3U")) return source;

  const lines = source.replace(/\r/g, "").split("\n");
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Líneas URI normales: variantes, segmentos, subtítulos externos, etc.
    if (!trimmed.startsWith("#")) {
      return proxyResourceUrl(trimmed, baseUrl, workerOrigin, context);
    }

    // URI="..." dentro de EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA,
    // EXT-X-I-FRAME-STREAM-INF, EXT-X-SESSION-KEY y otras etiquetas.
    return line.replace(/URI=("([^"]+)"|'([^']+)')/gi, (full, quoted, doubleValue, singleValue) => {
      const uri = doubleValue || singleValue || "";
      const rewritten = proxyResourceUrl(uri, baseUrl, workerOrigin, context);
      return `URI="${rewritten.replace(/"/g, "%22")}"`;
    });
  }).join("\n");
}

function proxyResourceUrl(resource, baseUrl, workerOrigin, context) {
  const value = String(resource || "").trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return value;

  let absolute;
  try {
    absolute = new URL(value, baseUrl).toString();
  } catch {
    return value;
  }

  // Evita envolver dos veces enlaces que ya apuntan a este Worker.
  try {
    const parsed = new URL(absolute);
    if (parsed.origin === workerOrigin && parsed.pathname === "/proxy" && parsed.searchParams.has("url")) {
      return absolute;
    }
  } catch {}

  const proxied = new URL("/proxy", workerOrigin);
  proxied.searchParams.set("url", absolute);
  if (context.ref) proxied.searchParams.set("ref", context.ref);
  if (context.ua) proxied.searchParams.set("ua", context.ua);
  if (context.origin) proxied.searchParams.set("origin", context.origin);
  return proxied.toString();
}

function copyUsefulHeaders(source) {
  const headers = new Headers();
  const allowed = [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Content-Disposition",
    "ETag",
    "Last-Modified",
  ];
  allowed.forEach((name) => {
    const value = source.get(name);
    if (value) headers.set(name, value);
  });
  return headers;
}

function cleanHeader(value) {
  if (!value) return "";
  return String(value).replace(/[\r\n]/g, "").trim().slice(0, 2048);
}

function isBlockedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local")) return true;

  // Bloqueo básico de destinos privados/loopback para evitar SSRF evidente.
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  return false;
}

async function safeText(response) {
  try {
    const type = (response.headers.get("Content-Type") || "").toLowerCase();
    if (type.includes("text") || type.includes("json") || type.includes("xml")) return await response.text();
  } catch {}
  return "";
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
