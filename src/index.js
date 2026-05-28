export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerPath = url.pathname;
    
    // === PATH-BASED URL EXTRACTION ===
    // Remove the leading slash to get the target URL
    // Example: "/http://example.com/file.m3u8" → "http://example.com/file.m3u8"
    let targetUrlStr = workerPath.startsWith('/') ? workerPath.substring(1) : workerPath;
    
    // Also support query parameter fallback for backward compatibility
    if (!targetUrlStr && url.searchParams.has('url')) {
      targetUrlStr = url.searchParams.get('url');
    }
    
    // Handle root path - show usage
    if (!targetUrlStr || workerPath === '/') {
      return new Response(
      //  `<h1>🎬 HLS Stream Proxy</h1>
         <p>Usage: Append your stream URL directly after the worker URL:</p>
         <code>${url.origin}/http://example.com/stream.m3u8</code>
   //      <h3>Example:</h3>
   //      <code>${url.origin}/http://moo7-restream2025.ddns.net:9091/Sport_tv_ts7/index.m3u8</code>
   //      <h3>Embed in iframe:</h3>
   //      <code>&lt;iframe src="${url.origin}/http://moo7-restream2025.ddns.net:9091/Sport_tv_ts7/index.m3u8"&gt;&lt;/iframe&gt;</code>`,
        { 
          headers: { 'Content-Type': 'text/html;charset=UTF-8' },
          status: 200
        }
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
      return new Response(`Error: Invalid URL "${targetUrlStr}"`, { status: 400 });
    }
    
    // === DETECT HLS CONTENT ===
    const isM3U8 = targetUrl.pathname.endsWith('.m3u8');
    const isTS = targetUrl.pathname.endsWith('.ts');
    const isM3U8List = targetUrl.pathname.endsWith('.m3u8');
    
    // === HANDLE M3U8 PLAYLIST ===
    if (isM3U8 || isM3U8List) {
      try {
        const response = await fetch(targetUrl.toString(), {
          headers: {
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
            'Accept': '*/*',
          }
        });
        
        if (!response.ok) {
          return new Response(`Failed to fetch playlist: HTTP ${response.status}`, { status: response.status });
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
          
          // Handle EXT-X-MAP (initialization segment)
          if (line.startsWith('#EXT-X-MAP:')) {
            const uriMatch = line.match(/URI="([^"]+)"/);
            if (uriMatch) {
              const originalUri = uriMatch[1];
              const fullUri = originalUri.startsWith('http') ? originalUri : baseUrl + originalUri;
              const newUri = `${url.origin}/${encodeURIComponent(fullUri)}`;
              line = line.replace(uriMatch[0], `URI="${newUri}"`);
            }
            newLines.push(line);
            continue;
          }
          
          // Handle segment URLs (lines that don't start with #)
          if (!line.startsWith('#')) {
            let segmentUrl = line;
            if (!segmentUrl.startsWith('http')) {
              segmentUrl = baseUrl + segmentUrl;
            }
            // Preserve the segment URL as-is in the path
            newLines.push(`${url.origin}/${segmentUrl}`);
          } else {
            newLines.push(line);
          }
        }
        
        return new Response(newLines.join('\n'), {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
          }
        });
      } catch (error) {
        return new Response(`Proxy error: ${error.message}`, { status: 502 });
      }
    }
    
    // === HANDLE TS SEGMENTS ===
    if (isTS) {
      try {
        const response = await fetch(targetUrl.toString(), {
          headers: {
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
            'Referer': targetUrl.origin,
          }
        });
        
        if (!response.ok) {
          return new Response(`Failed to fetch segment: HTTP ${response.status}`, { status: response.status });
        }
        
        const headers = new Headers(response.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Content-Type', 'video/MP2T');
        headers.set('Cache-Control', 'public, max-age=3600');
        headers.delete('Content-Length'); // Let Cloudflare handle streaming
        
        return new Response(response.body, {
          status: response.status,
          headers: headers,
        });
      } catch (error) {
        return new Response(`Segment error: ${error.message}`, { status: 502 });
      }
    }
    
    // === HANDLE OTHER FILE TYPES (images, videos, etc.) ===
    try {
      const response = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
        }
      });
      
      if (!response.ok) {
        return new Response(`Failed to fetch: HTTP ${response.status}`, { status: response.status });
      }
      
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      
      return new Response(response.body, {
        status: response.status,
        headers: headers,
      });
    } catch (error) {
      return new Response(`Fetch error: ${error.message}`, { status: 502 });
    }
  }
}
