export class HeaderBuilder {
  static getBaseHeaders(url: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Dest': 'document',
    };
    return headers;
  }

  static getHeadersForProvider(providerType: string, targetUrl: string): Record<string, string> {
    const headers = this.getBaseHeaders(targetUrl);
    
    try {
      const url = new URL(targetUrl).href; // Full URL for referer
      const origin = new URL(targetUrl).origin;
      
      switch (providerType) {
        case 'anime':
          headers['Referer'] = url; // Anime CDNs require self-referral
          headers['Origin'] = origin;
          headers['Sec-Fetch-Site'] = 'same-origin';
          break;
        case 'hanime':
          headers['Referer'] = 'https://hanime.tv/';
          headers['Origin'] = 'https://hanime.tv';
          break;
        case 'movie':
          headers['Referer'] = origin + '/';
          headers['Origin'] = origin;
          headers['Sec-Fetch-Site'] = 'same-origin';
          break;
        case 'instagram':
          headers['Sec-Fetch-Site'] = 'same-origin';
          break;
        case 'adult':
          headers['Referer'] = 'https://www.google.com/'; // Pretend to come from Google
          headers['Sec-Fetch-Site'] = 'cross-site';
          break;
      }
    } catch (e) {}
    
    return headers;
  }

  static formatForYTDLP(headers: Record<string, string>, userAgent?: string): string[] {
    const args: string[] = [];
    if (userAgent) {
      args.push('--user-agent', userAgent);
    }
    for (const [key, value] of Object.entries(headers)) {
      args.push('--add-header', `${key}:${value}`);
    }
    return args;
  }
}
