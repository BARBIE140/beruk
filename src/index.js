export default {
  async fetch(request, env, ctx) {
    const workerUrl = new URL(request.url);
    const proxyPrefix = `${workerUrl.origin}${workerUrl.pathname}?`;
    
    // Get target URL from query string
    let targetUrlStr = workerUrl.search.substring(1);
    
    if (!targetUrlStr && workerUrl.searchParams.has('miniProxyFormAction')) {
      targetUrlStr = workerUrl.searchParams.get('miniProxyFormAction');
    }
    
    if (!targetUrlStr) {
      return new Response(
        `<h1>HLS Stream Proxy</h1>
         <p>Usage: <code>${proxyPrefix}http://your-stream.com/stream.m3u8</code></p>`,
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    
    // Ensure scheme exists
    if (!/^https?:\/\//i.test(targetUrlStr)) {
      targetUrlStr = 'http://' + targetUrlStr;
    }
    
    let targetUrl;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch (e) {
      return new Response("Invalid URL", { status: 400 });
    }
    
    // === SPECIAL HLS HANDLING ===
    // Detect if this is a .m3u8 playlist or .ts segment
    const isM3U8 = targetUrl.pathname.endsWith('.m3u8');
    const isTS = targetUrl.pathname.endsWith('.ts');
    
    if (isM3U8) {
      // Fetch and rewrite the playlist
      const response = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
        }
      });
      
      if (!response.ok) {
        return new Response(`Failed to fetch playlist: ${response.status}`, { status: response.status });
      }
      
      const content = await response.text();
      const baseUrl = targetUrl.origin + targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);
      const lines = content.split('\n');
      const newLines = [];
      
      for (let line of lines) {
        line = line.trimEnd();
        
        if (line === '') {
          newLines.push(line);
          continue;
        }
        
        // Handle EXT-X-MAP (init segment)
        if (line.startsWith('#EXT-X-MAP:')) {
          const uriMatch = line.match(/URI="([^"]+)"/);
          if (uriMatch) {
            const originalUri = uriMatch[1];
            const fullUri = originalUri.startsWith('http') ? originalUri : baseUrl + originalUri;
            const newUri = `${workerUrl.origin}${workerUrl.pathname}?${encodeURIComponent(fullUri)}`;
            line = line.replace(uriMatch[0], `URI="${newUri}"`);
          }
          newLines.push(line);
          continue;
        }
        
        // Handle segment URLs
        if (!line.startsWith('#')) {
          let segmentUrl = line;
          if (!segmentUrl.startsWith('http')) {
            segmentUrl = baseUrl + segmentUrl;
          }
          newLines.push(`${workerUrl.origin}${workerUrl.pathname}?${encodeURIComponent(segmentUrl)}`);
        } else {
          newLines.push(line);
        }
      }
      
      return new Response(newLines.join('\n'), {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        }
      });
    }
    
    if (isTS) {
      // Direct fetch for video segments
      const response = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
        }
      });
      
      if (!response.ok) {
        return new Response(`Failed to fetch segment`, { status: response.status });
      }
      
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Content-Type', 'video/MP2T');
      headers.set('Cache-Control', 'public, max-age=3600');
      
      return new Response(response.body, {
        status: response.status,
        headers: headers,
      });
    }
    
    // === For regular HTML/CSS/Images (your miniProxy logic) ===
    const newHeaders = new Headers(request.headers);
    newHeaders.delete("Host");
    newHeaders.delete("Origin");
    newHeaders.delete("Accept-Encoding");
    
    const fetchOptions = {
      method: request.method,
      headers: newHeaders,
      redirect: "follow"
    };
    
    if (request.method !== "GET" && request.method !== "HEAD") {
      let bodyBytes = await request.arrayBuffer();
      if (request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
        const bodyText = new TextDecoder().decode(bodyBytes);
        const params = new URLSearchParams(bodyText);
        if (params.has("miniProxyFormAction")) {
          params.delete("miniProxyFormAction");
        }
        bodyBytes = new TextEncoder().encode(params.toString());
      }
      fetchOptions.body = bodyBytes;
    }
    
    let response = await fetch(targetUrl.toString(), fetchOptions);
    
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("Content-Length");
    responseHeaders.delete("Transfer-Encoding");
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("X-Robots-Tag", "noindex, nofollow");
    
    const contentType = responseHeaders.get("Content-Type") || "";
    
    // HTML rewriting (your existing logic)
    if (contentType.includes("text/html")) {
      const rewriter = new HTMLRewriter()
        .on("a[href], link[href], img[src], script[src], iframe[src]", {
          element(el) {
            const attr = el.hasAttribute("href") ? "href" : "src";
            const value = el.getAttribute(attr);
            if (value && !value.startsWith("data:") && !value.startsWith("#")) {
              try {
                const absolute = new URL(value, targetUrl.href).href;
                el.setAttribute(attr, proxyPrefix + absolute);
              } catch(e) {}
            }
          }
        })
        .on("form", {
          element(el) {
            const action = el.getAttribute("action") || "";
            const absoluteAction = new URL(action, targetUrl.href).href;
            el.setAttribute("action", workerUrl.origin + workerUrl.pathname);
            el.append(`<input type="hidden" name="miniProxyFormAction" value="${escapeHtml(absoluteAction)}" />`, { html: true });
          }
        });
      
      return rewriter.transform(new Response(response.body, { headers: responseHeaders, status: response.status }));
    }
    
    // CSS handling
    if (contentType.includes("text/css")) {
      const css = await response.text();
      const rewrittenCss = css.replace(/url\((.*?)\)/gi, (match, p1) => {
        let url = p1.replace(/['"]/g, "").trim();
        if (url.startsWith("data:")) return match;
        try {
          const absolute = new URL(url, targetUrl.href).href;
          return `url("${proxyPrefix}${absolute}")`;
        } catch(e) {
          return match;
        }
      });
      return new Response(rewrittenCss, { headers: responseHeaders });
    }
    
    // Everything else (images, etc.)
    return new Response(response.body, { headers: responseHeaders, status: response.status });
  }
};

function escapeHtml(str) {
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}
