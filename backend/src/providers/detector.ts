import { BaseProvider } from './base';
import { YouTubeProvider } from './youtube';
import { HanimeProvider } from './hanime';
import { AnimeProvider } from './anime';
import { MovieProvider } from './movie';
import { AdultProvider } from './adult';
import { GenericProvider } from './generic';
import { SiteRules } from './siteRules';
import { RulesProvider } from './rulesProvider';
import logger from '../logger';

export class ProviderDetector {
  // Hand-written providers for code-heavy sites (checked first, in order).
  private static specific: BaseProvider[] = [
    new YouTubeProvider(),
    new HanimeProvider(),   // Must be before AnimeProvider (hanime.tv also matches anime patterns)
    new AnimeProvider(),    // Must be before MovieProvider (embed players overlap)
    new MovieProvider(),
    new AdultProvider(),
  ];

  static detect(url: string): BaseProvider {
    // 1. Hand-written providers win (code-heavy sites).
    for (const provider of this.specific) {
      if (provider.match(url)) {
        logger.debug({ url, provider: provider.name }, 'Provider matched');
        return provider;
      }
    }
    // 2. Declarative data-driven site rules (A1) — onboard a site without code.
    const rule = SiteRules.match(url);
    if (rule) {
      const provider = new RulesProvider(rule);
      logger.debug({ url, provider: provider.name }, 'Site rule matched');
      return provider;
    }
    // 3. Generic fallback.
    return new GenericProvider();
  }
}
