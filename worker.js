const ALLOW_ALL_HOSTS = true;

/*
  HLS Proxy + Verificador para Watch TV Plus
  Endpoints:
  - /proxy?url=URL&ref=REFERER&ua=USER_AGENT
  - /check?url=URL&ref=REFERER&ua=USER_AGENT
*/

const ALLOWED_HOSTS = [
  "jmp2.uk",
  "pluto.tv",
  "plutotv.net",
  "stitcher.pluto.tv",
  "stitcher-ipv4.pluto.tv",
  "service-stitcher.clusters.pluto.tv",
  "service-concierge.clusters.pluto.tv",
  "boot.pluto.tv"
];

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/check") {
      return handleCheck(request);
    }

    if (requestUrl.pathname !== "/proxy") {
      return new Response("HLS Proxy funcionando. Usa /proxy o /check", {
        headers: {
          ...corsHeaders(),
          "Content-Type": "text/plain; charset=utf-8"
        }
      });
    }

    return handleProxy(request);
  }
};

async function handleProxy(request) {
  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get("url");
  const customReferrer = requestUrl.searchParams.get("ref") || "";
  const customUserAgent = requestUrl.searchParams.get("ua") || "";

  const parsed = parseTarget(target);
  if (!parsed.ok) return textResponse(parsed.error, parsed.status || 400);

  const targetUrl = parsed.url;

  let response;
  try {
    response = await fetchUpstream(targetUrl, request, customReferrer, customUserAgent);
  } catch (error) {
    return textResponse("Error al cargar origen: " + error.message, 502);
  }

  const finalUrl = new URL(response.url || targetUrl.toString());
  const contentType = response.headers.get("content-type") || "";
  const path = finalUrl.pathname.toLowerCase();

  const looksLikeM3U8 = isM3U8Like(contentType, path, targetUrl.pathname);
  const maybeTextPlaylist = looksLikeM3U8 || contentType.includes("text/") || path.endsWith(".php") || path.endsWith(".m3u") || path.includes("playlist");

  if (maybeTextPlaylist) {
    const bodyText = await response.text();

    if (looksLikeM3U8 || bodyText.trimStart().startsWith("#EXTM3U")) {
      const rewrittenPlaylist = rewritePlaylist(bodyText, finalUrl, request.url);

      return new Response(rewrittenPlaylist, {
        status: response.status,
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    }

    return new Response(bodyText, {
      status: response.status,
      headers: {
        ...corsHeaders(),
        "Content-Type": contentType || "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      }
    });
  }

  return streamResponse(response);
}

async function handleCheck(request) {
  const started = Date.now();
  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get("url");
  const customReferrer = requestUrl.searchParams.get("ref") || "";
  const customUserAgent = requestUrl.searchParams.get("ua") || "";

  const parsed = parseTarget(target);
  if (!parsed.ok) {
    return jsonResponse({
      ok: false,
      stage: "url",
      message: parsed.error,
      elapsedMs: Date.now() - started
    }, parsed.status || 400);
  }

  try {
    const result = await checkPlaylist(parsed.url, request, customReferrer, customUserAgent, 0);
    result.elapsedMs = Date.now() - started;
    return jsonResponse(result, 200);
  } catch (error) {
    return jsonResponse({
      ok: false,
      stage: "exception",
      message: error.message,
      elapsedMs: Date.now() - started
    }, 200);
  }
}

async function checkPlaylist(targetUrl, request, ref, ua, depth) {
  if (depth > 2) {
    return {
      ok: false,
      stage: "depth",
      message: "Demasiadas playlists anidadas",
      finalUrl: targetUrl.toString()
    };
  }

  const response = await fetchUpstream(targetUrl, request, ref, ua);
  const finalUrl = new URL(response.url || targetUrl.toString());
  const contentType = response.headers.get("content-type") || "";
  const status = response.status;

  if (!response.ok) {
    return {
      ok: false,
      stage: "manifest",
      status,
      finalUrl: finalUrl.toString(),
      contentType,
      message: "El manifest respondió con error HTTP " + status
    };
  }

  const text = await response.text();
  const trimmed = text.trimStart();

  if (!trimmed.startsWith("#EXTM3U")) {
    return {
      ok: false,
      stage: "manifest",
      status,
      finalUrl: finalUrl.toString(),
      contentType,
      message: "La respuesta no parece ser una playlist M3U8",
      preview: trimmed.slice(0, 120)
    };
  }

  const lines = text.replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
  const variantUrl = findVariantUrl(lines, finalUrl);

  if (variantUrl) {
    const childResult = await checkPlaylist(variantUrl, request, ref, ua, depth + 1);
    return {
      ...childResult,
      masterOk: true,
      masterFinalUrl: finalUrl.toString(),
      masterStatus: status
    };
  }

  const keyUrl = findKeyUrl(lines, finalUrl);
  if (keyUrl) {
    const keyResp = await fetchUpstream(keyUrl, request, ref, ua, true);
    if (!keyResp.ok) {
      return {
        ok: false,
        stage: "key",
        status: keyResp.status,
        finalUrl: finalUrl.toString(),
        keyUrl: keyUrl.toString(),
        message: "La playlist abre, pero la llave HLS no carga"
      };
    }
    await safeCancel(keyResp);
  }

  const segmentUrl = findSegmentUrl(lines, finalUrl);
  if (!segmentUrl) {
    return {
      ok: true,
      stage: "manifest-only",
      status,
      finalUrl: finalUrl.toString(),
      contentType,
      hasKey: !!keyUrl,
      message: "La playlist abre, pero no encontré segmento para probar"
    };
  }

  const segResp = await fetchUpstream(segmentUrl, request, ref, ua, true);
  const segStatus = segResp.status;
  const segType = segResp.headers.get("content-type") || "";
  await safeCancel(segResp);

  if (!segResp.ok && segStatus !== 206) {
    return {
      ok: false,
      stage: "segment",
      status: segStatus,
      finalUrl: finalUrl.toString(),
      segmentUrl: segmentUrl.toString(),
      contentType,
      segmentContentType: segType,
      hasKey: !!keyUrl,
      message: "El manifest abre, pero el primer segmento no carga"
    };
  }

  return {
    ok: true,
    stage: "segment",
    status,
    segmentStatus: segStatus,
    finalUrl: finalUrl.toString(),
    contentType,
    segmentContentType: segType,
    hasKey: !!keyUrl,
    message: "Manifest y primer segmento cargan correctamente"
  };
}

function parseTarget(target) {
  if (!target) {
    return { ok: false, error: "Falta parámetro url", status: 400 };
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (error) {
    return { ok: false, error: "URL inválida", status: 400 };
  }

  if (!isAllowedHost(targetUrl.hostname)) {
    return { ok: false, error: "Host no permitido: " + targetUrl.hostname, status: 403 };
  }

  return { ok: true, url: targetUrl };
}

async function fetchUpstream(targetUrl, request, customReferrer = "", customUserAgent = "", rangeSmall = false) {
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("Accept", "*/*");
  upstreamHeaders.set("User-Agent", customUserAgent || "Mozilla/5.0");

  if (customReferrer) {
    upstreamHeaders.set("Referer", customReferrer);
    try {
      const refUrl = new URL(customReferrer);
      upstreamHeaders.set("Origin", refUrl.origin);
    } catch (e) {}
  } else if (
    targetUrl.hostname.includes("pluto.tv") ||
    targetUrl.hostname.includes("plutotv.net") ||
    targetUrl.hostname.includes("jmp2.uk")
  ) {
    upstreamHeaders.set("Origin", "https://pluto.tv");
    upstreamHeaders.set("Referer", "https://pluto.tv/");
  }

  const incomingRange = request.headers.get("Range");
  if (incomingRange) {
    upstreamHeaders.set("Range", incomingRange);
  } else if (rangeSmall) {
    upstreamHeaders.set("Range", "bytes=0-1023");
  }

  return fetch(targetUrl.toString(), {
    method: "GET",
    headers: upstreamHeaders,
    redirect: "follow",
    cf: {
      cacheTtl: 0,
      cacheEverything: false
    }
  });
}

function rewritePlaylist(playlist, baseUrl, workerUrl) {
  return playlist
    .split("\n")
    .map(line => {
      let output = line;

      output = output.replace(/URI="([^"]+)"/g, function(match, uri) {
        try {
          const absoluteUrl = new URL(uri, baseUrl).toString();
          return `URI="${proxyUrl(absoluteUrl, workerUrl)}"`;
        } catch (error) {
          return match;
        }
      });

      const cleanLine = output.trim();

      if (!cleanLine || cleanLine.startsWith("#")) {
        return output;
      }

      try {
        const absoluteUrl = new URL(cleanLine, baseUrl).toString();
        return proxyUrl(absoluteUrl, workerUrl);
      } catch (error) {
        return output;
      }
    })
    .join("\n");
}

function proxyUrl(target, workerUrl) {
  const currentWorkerUrl = new URL(workerUrl);
  const ref = currentWorkerUrl.searchParams.get("ref") || "";
  const ua = currentWorkerUrl.searchParams.get("ua") || "";

  const url = new URL(workerUrl);
  url.pathname = "/proxy";
  url.search = "";
  url.searchParams.set("url", target);

  if (ref) url.searchParams.set("ref", ref);
  if (ua) url.searchParams.set("ua", ua);

  return url.toString();
}

function findVariantUrl(lines, baseUrl) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith("#")) {
          return new URL(lines[j], baseUrl);
        }
      }
    }
  }
  return null;
}

function findKeyUrl(lines, baseUrl) {
  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY")) {
      const match = line.match(/URI="([^"]+)"/);
      if (match && match[1]) {
        return new URL(match[1], baseUrl);
      }
    }
  }
  return null;
}

function findSegmentUrl(lines, baseUrl) {
  for (const line of lines) {
    if (!line.startsWith("#")) {
      return new URL(line, baseUrl);
    }
  }
  return null;
}

function isM3U8Like(contentType, path, originalPath) {
  const p = String(path || "").toLowerCase();
  const op = String(originalPath || "").toLowerCase();
  const ct = String(contentType || "").toLowerCase();

  return ct.includes("mpegurl") ||
    ct.includes("application/vnd.apple.mpegurl") ||
    ct.includes("audio/mpegurl") ||
    p.includes(".m3u8") ||
    op.includes(".m3u8");
}

function streamResponse(response) {
  const responseHeaders = {
    ...corsHeaders(),
    "Content-Type": response.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Accept-Ranges": response.headers.get("accept-ranges") || "bytes"
  };

  const contentRange = response.headers.get("content-range");
  if (contentRange) responseHeaders["Content-Range"] = contentRange;

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders
  });
}

async function safeCancel(response) {
  try {
    if (response && response.body) await response.body.cancel();
  } catch (e) {}
}

function isAllowedHost(hostname) {
  if (ALLOW_ALL_HOSTS) return true;

  return ALLOWED_HOSTS.some(host => {
    return hostname === host || hostname.endsWith("." + host);
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges"
  };
}

function textResponse(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
