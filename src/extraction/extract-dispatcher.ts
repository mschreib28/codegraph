import * as path from 'path';
import { Language, ExtractionResult } from '../types';
import { detectLanguage } from './grammars';
import { TreeSitterExtractor } from './tree-sitter';
import { SvelteExtractor } from './svelte-extractor';
import { LiquidExtractor } from './liquid-extractor';
import { DfmExtractor } from './dfm-extractor';

export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    return extractor.extract();
  }

  if (detectedLanguage === 'liquid') {
    const extractor = new LiquidExtractor(filePath, source);
    return extractor.extract();
  }

  if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    const extractor = new DfmExtractor(filePath, source);
    return extractor.extract();
  }

  const extractor = new TreeSitterExtractor(filePath, source, detectedLanguage);
  return extractor.extract();
}
