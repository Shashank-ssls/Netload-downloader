✦ Here is the documentation outlining how to approach and reverse-engineer these complex, dynamically rendered sites in the future, adhering to the project's strict architectural
  constraints.

  You can save this as DYNAMIC_SITES_GUIDE.md in your project root for future reference.

  ---

  Guide: Handling Dynamic & Protected Video Sites

  This document outlines the strategy for adding support for complex, dynamic websites (like miruro.tv and mitaku.net) to the NetLoad Downloader, adhering to the strict architectural
  rule: NO Headless Browsers (Puppeteer, Playwright, etc.).

  The Challenge

  Sites are categorized as DYNAMIC_CONTENT_UNSUPPORTED when yt-dlp fails because it cannot execute JavaScript. These sites typically employ one of two strategies:
   1. Single Page Applications (SPAs): Sites built with React, Vue, or Next.js (e.g., miruro.tv) load an empty HTML shell. The actual media URLs are fetched later via internal API calls
      (REST or GraphQL).
   2. Obfuscated Embedders: Sites (e.g., mitaku.net using bysesayeveum.com) use heavy JavaScript obfuscation and token generation to construct the media URL on the fly, preventing simple
      scraping.

  General Resolution Strategy: Reverse Engineering

  Since we cannot run a browser, we must reverse-engineer the site's logic and replicate the network requests directly using axios.

  Step 1: Network Analysis
   1. Open the target site in your browser.
   2. Open Developer Tools (F12) and go to the Network tab.
   3. Filter by Fetch/XHR or Media.
   4. Play the video.
   5. Look for requests returning .m3u8, .mp4, or JSON containing these links.

  Step 2: Request Replication
  Once you find the API call that returns the video link:
   1. Right-click the request -> Copy as cURL (bash/cmd).
   2. Analyze the required headers (Referer, Origin, User-Agent, Custom Tokens).
   3. Determine how the tokens/auth headers are generated (are they in the initial HTML? cookies? a previous API call?).

  ---

  Case Studies

  1. SPAs (e.g., Miruro.tv)
  Miruro is a Next.js application. 
   * Observation: The initial HTML contains a large <script>window.__SSR_DATA__ = {...}</script> block, but the actual video stream URLs are often fetched dynamically based on the
     selected provider (e.g., Kiwi, Allmoe).
   * Action Plan:
       1. Fetch the initial HTML using axios.
       2. Extract the episode ID or server ID from __SSR_DATA__ using regex or string parsing.
       3. Find the API endpoint Miruro uses to resolve the server ID into an .m3u8 link (e.g., a GraphQL query or a specific /api/v1/stream endpoint).
       4. Make an axios request to that API endpoint with the necessary IDs to get the raw stream.

  2. Obfuscated Embedders (e.g., bysesayeveum.com on Mitaku)
  Mitaku embeds an iframe pointing to bysesayeveum.com.
   * Observation: The embed page uses JavaScript to decrypt a payload or perform a handshake before requesting the video.
   * Action Plan:
       1. Our FallbackExtractor already finds the iframe URL (https://bysesayeveum.com/e/...).
       2. Analyze the network traffic of that iframe in your browser. You will likely find an API call returning JSON with the stream URL, or a heavily obfuscated .js file unpacking a
          string.
       3. If it's a simple API call, replicate it. If it requires a token, you must find where the token is generated in the HTML (often stored in hidden input fields or JS variables)
          and pass it in your axios request.

  ---

  Implementation in NetLoad Downloader

  When you have reverse-engineered the API, implement it in the backend:

   1. Create a Dedicated Extractor: If the logic is complex, create a new file (e.g., backend/src/extractors/miruroExtractor.ts).
   2. Use Axios: Use axios to make the specific API requests. Ensure you pass the correct headers using HeaderBuilder.getBaseHeaders().
   3. Integrate: Call your new extractor from analyzeUrl in analyzer.ts or add a specific Provider in backend/src/providers/ that intercepts the URL before it reaches the generic
      fallback.

  Example Stub

    1 // backend/src/extractors/customExtractor.ts
    2 import axios from 'axios';
    3 import logger from '../logger';
    4
    5 export class CustomExtractor {
    6   static async resolveDynamicUrl(url: string): Promise<string | null> {
    7     try {
    8       // 1. Fetch initial page to get tokens/IDs
    9       const pageRes = await axios.get(url);
   10       const dataIdMatch = pageRes.data.match(/data-id="([^"]+)"/);
   11       
   12       if (!dataIdMatch) return null;
   13       const id = dataIdMatch[1];
   14
   15       // 2. Call the hidden API
   16       const apiRes = await axios.get(`https://example.com/api/get_stream/${id}`, {
   17         headers: {
   18           'Referer': url,
   19           'X-Requested-With': 'XMLHttpRequest'
   20         }
   21       });
   22
   23       return apiRes.data.stream_url; // Return the raw .m3u8 or .mp4
   24     } catch (err) {
   25       logger.error('Failed to reverse-engineer dynamic URL');
   26       return null;
   27     }
   28   }
   29 }