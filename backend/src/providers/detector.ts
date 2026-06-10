import { BaseProvider } from './base';
import { YouTubeProvider } from './youtube';
import { HanimeProvider } from './hanime';
import { AnimeProvider } from './anime';
import { MovieProvider } from './movie';
import { AdultProvider } from './adult';
import { GenericProvider } from './generic';
import logger from '../logger';

export class ProviderDetector {
  private static providers: BaseProvider[] = [
    new YouTubeProvider(),
    new HanimeProvider(),   // Must be before AnimeProvider (hanime.tv also matches anime patterns)
    new AnimeProvider(),    // Must be before MovieProvider (embed players overlap)
    new MovieProvider(),
    new AdultProvider(),
    new GenericProvider(),  // MUST remain last
  ];

  static detect(url: string): BaseProvider {
    for (const provider of this.providers) {
      if (provider.match(url)) {
        logger.debug({ url, provider: provider.name }, 'Provider matched');
        return provider;
      }
    }
    return new GenericProvider();
  }
}
