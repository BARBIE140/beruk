export default {
  async fetch(request, env, ctx) {
    const workerUrl = new URL(request.url);
    const proxyPrefix = `${workerUrl.origin}${workerUrl.pathname}?`;

    // 1. Extract the destination URL from the query string
    let targetUrlStr = workerUrl.search.substring(1); // Strips the leading '?'
    
    // If miniProxyFormAction is sent via POST or GET fallback
    if (!targetUrlStr && workerUrl.searchParams.has('miniProxyFormAction')) {
      targetUrlStr = workerUrl.searchParams.get('miniProxyFormAction');
    }

    // Default Landing / Error handling if no URL is provided
    if (!targetUrlStr) {
      return new Response(
        `<h1>miniProxy (Cloudflare Worker Edition)</h1>
         <p>Pass the URL you want to proxy in the query string. Example:</p>
         <a href="${proxyPrefix}https://example.com">${proxyPrefix}https://example.com</a>`,
        { headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
      );
    }

    // Ensure the target URL has a scheme
    if (!/^https?:\/\//i.test(targetUrlStr)) {
      targetUrlStr = 'http://' + targetUrlStr;
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch (e) {
      return new Response("Error: Invalid target URL specified.", { status: 400 });
    }

    // 2. Prepare the Request Headers (Anonymize & Filter)
    const newHeaders = new Headers(request.headers);
    newHeaders.delete("Host");
    newHeaders.delete("Origin");
    newHeaders.delete("Accept-Encoding"); // Let CF fetch handle compression natively

    // Config option: $anonymize = true equivalent
    // Cloudflare natively strips/manages X-Forwarded-For, but we ensure cleanliness
    newHeaders.delete("X-Forwarded-For");

    // 3. Clone and forward the request to the target destination
    const fetchOptions = {
      method: request.method,
      headers: newHeaders,
      redirect: "follow" // Equivalent to CURLOPT_FOLLOWLOCATION
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      // For POST/PUT requests, handle the body payload
      let bodyBytes = await request.arrayBuffer();
      
      // If it's a form submission, handle miniProxyFormAction replacement
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

    // Perform the upstream request
    let response = await fetch(targetUrl.toString(), fetchOptions);

    // If the server followed a redirect to a completely different location, update proxy target
    if (response.url && response.url !== targetUrl.toString()) {
      targetUrl = new URL(response.url);
    }

    // 4. Handle Response Headers
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("Content-Length");
    responseHeaders.delete("Transfer-Encoding");
    responseHeaders.delete("Content-Encoding");
    responseHeaders.set("X-Robots-Tag", "noindex, nofollow");

    // Handle CORS configuration ($forceCORS = true)
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Credentials", "true");

    if (request.method === "OPTIONS") {
      if (request.headers.has("Web-Access-Control-Request-Method")) {
        responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      }
      if (request.headers.has("Web-Access-Control-Request-Headers")) {
        responseHeaders.set("Access-Control-Allow-Headers", request.headers.get("Web-Access-Control-Request-Headers"));
      }
      return new Response(null, { headers: responseHeaders, status: 204 });
    }

    const contentType = responseHeaders.get("Content-Type") || "";

    // 5. DOM Rewriting (Proxification) via Cloudflare HTMLRewriter
    if (contentType.includes("text/html")) {
      
      // Helper to generate absolute rewritten URLs pointing back to the worker
      const proxifyUrl = (attrValue) => {
        if (!attrValue) return attrValue;
        if (/^(about|javascript|magnet|mailto):|#/i.test(attrValue)) return attrValue;
        if (/^(data):/i.test(attrValue)) return attrValue;
        
        try {
          // Resolve relative URLs to absolute URLs using the target upstream URL as base
          const absolute = new URL(attrValue, targetUrl.href).href;
          return proxyPrefix + absolute;
        } catch(e) {
          return attrValue;
        }
      };

      // Transform HTML stream elements dynamically
      const rewriter = new HTMLRewriter()
        // Proxify basic asset links and references
        .on("a[href], link[href], img[src], script[src], iframe[src], source[src]", {
          element(el) {
            const attr = el.hasAttribute("href") ? "href" : "src";
            el.setAttribute(attr, proxifyUrl(el.getAttribute(attr)));
          }
        })
        // Proxify image source sets (srcset)
        .on("img[srcset], source[srcset]", {
          element(el) {
            const srcset = el.getAttribute("srcset");
            const proxifiedSrcset = srcset.split(",").map(part => {
              const trimmed = part.trim();
              const spaceIdx = trimmed.lastIndexOf(" ");
              if (spaceIdx === -1) return proxifyUrl(trimmed);
              const urlPart = trimmed.substring(0, spaceIdx);
              const descriptor = trimmed.substring(spaceIdx);
              return proxifyUrl(urlPart) + descriptor;
            }).join(", ");
            el.setAttribute("srcset", proxifiedSrcset);
          }
        })
        // Rewrite Forms to submit back to the proxy with hidden tracking elements
        .on("form", {
          element(el) {
            const action = el.getAttribute("action") || "";
            const absoluteAction = new URL(action, targetUrl.href).href;
            
            // Clean action so it posts to the worker path directly
            el.setAttribute("action", workerUrl.origin + workerUrl.pathname);
            el.append(`<input type="hidden" name="miniProxyFormAction" value="${escapeHtml(absoluteAction)}" />`, { html: true });
          }
        })
        // Proxify raw elements containing inline style rules
        .on("*[style]", {
          element(el) {
            el.setAttribute("style", proxifyCSS(el.getAttribute("style"), targetUrl.href, proxyPrefix));
          }
        })
        // Proxify dedicated <style> tags
        .on("style", {
          text(textChunk) {
            // Note: Since tags can deliver text chunks split up, standard proxying rules 
            // are best managed safely here, though complex multi-chunk CSS strings may need buffering.
            if (textChunk.text) {
              textChunk.replace(proxifyCSS(textChunk.text, targetUrl.href, proxyPrefix));
            }
          }
        })
        // Prepend AJAX interception scripts into the <head> or <body>
        .on("head, body", {
          element(el) {
            // Drop-in script hook to intercept native client-side XMLHttpRequests
            const ajaxHack = `
              <script type="text/javascript">
              (function() {
                if (!window.XMLHttpRequest) return;
                var originalOpen = window.XMLHttpRequest.prototype.open;
                window.XMLHttpRequest.prototype.open = function() {
                  if (arguments[1]) {
                    var inputUrl = arguments[1];
                    if (!inputUrl.startsWith("http://") && !inputUrl.startsWith("https://")) {
                      inputUrl = new URL(inputUrl, "${targetUrl.href}").href;
                    }
                    if (!inputUrl.includes("${proxyPrefix}")) {
                      arguments[1] = "${proxyPrefix}" + inputUrl;
                    }
                  }
                  return originalOpen.apply(this, [].slice.call(arguments));
                };
              })();
              </script>
            `;
            el.prepend(ajaxHack, { html: true });
          }
        });

      return rewriter.transform(new Response(response.body, { headers: responseHeaders, status: response.status }));
    }

    // 6. Handle CSS context directly (if loaded independently)
    if (contentType.includes("text/css")) {
      const rawCss = await response.text();
      const rewrittenCss = proxifyCSS(rawCss, targetUrl.href, proxyPrefix);
      return new Response(rewrittenCss, { headers: responseHeaders, status: response.status });
    }

    // 7. Fallback: Return raw body stream for files, images, videos etc.
    return new Response(response.body, { headers: responseHeaders, status: response.status });
  }
};

// --- Helper Functions Outside Core Fetch Execution ---

function proxifyCSS(cssText, baseUrl, proxyPrefix) {
  // Normalize rules missing url() wrappers inside @imports
  let normalized = cssText.replace(/@import\s+([^;\s("]+)/gi, (match, p1) => {
    return `@import url(${p1})`;
  });

  // Regex capture values within url(...) blocks
  return normalized.replace(/url\((.*?)\)/gi, (match, p1) => {
    let url = p1.replace(/['"]/g, "").trim();
    if (url.startsWith("data:")) return match; // Leave inline binaries alone
    
    try {
      const absolute = new URL(url, baseUrl).href;
      return `url("${proxyPrefix}${absolute}")`;
    } catch(e) {
      return match;
    }
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

