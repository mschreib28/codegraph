/**
 * Liquid — custom regex-based extractor for Shopify Liquid templates.
 * Tree-sitter has no production-quality Liquid grammar; the
 * `LiquidExtractor` does targeted pattern matching for snippet
 * includes and Drop variable references.
 */
import { LiquidExtractor } from '../liquid-extractor';
import type { LanguageDef } from './types';

export const LIQUID_DEF: LanguageDef = {
  name: 'liquid',
  displayName: 'Liquid',
  extensions: ['.liquid'],
  includeGlobs: ['**/*.liquid'],
  customExtractor: (filePath, source) => new LiquidExtractor(filePath, source).extract(),
};
