/**
 * Framework Resolver Registry
 *
 * Manages framework-specific resolvers.
 */

import { FrameworkResolver, ResolutionContext } from '../types';
import { laravelResolver } from './laravel';
import { expressResolver } from './express';
import { reactResolver } from './react';
import { svelteResolver } from './svelte';
import { djangoResolver, flaskResolver, fastapiResolver } from './python';
import { railsResolver } from './ruby';
import { springResolver } from './java';
import { goResolver } from './go';
import { rustResolver } from './rust';
import { aspnetResolver } from './csharp';
import { swiftUIResolver, uikitResolver, vaporResolver } from './swift';

/**
 * All registered framework resolvers
 */
const FRAMEWORK_RESOLVERS: FrameworkResolver[] = [
  // PHP
  laravelResolver,
  // JavaScript/TypeScript
  expressResolver,
  reactResolver,
  svelteResolver,
  // Python
  djangoResolver,
  flaskResolver,
  fastapiResolver,
  // Ruby
  railsResolver,
  // Java
  springResolver,
  // Go
  goResolver,
  // Rust
  rustResolver,
  // C#
  aspnetResolver,
  // Swift
  swiftUIResolver,
  uikitResolver,
  vaporResolver,
];

/**
 * Get all framework resolvers
 */
export function getAllFrameworkResolvers(): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS;
}

/**
 * Get a resolver by name
 */
export function getFrameworkResolver(name: string): FrameworkResolver | undefined {
  return FRAMEWORK_RESOLVERS.find((r) => r.name === name);
}

/**
 * Detect which frameworks are used in a project
 */
export async function detectFrameworks(context: ResolutionContext): Promise<FrameworkResolver[]> {
  const results = await Promise.all(
    FRAMEWORK_RESOLVERS.map(async (resolver) => {
      try {
        const detected = await resolver.detect(context);
        return detected ? resolver : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter((r): r is FrameworkResolver => r !== null);
}

/**
 * Register a custom framework resolver
 */
export function registerFrameworkResolver(resolver: FrameworkResolver): void {
  // Remove existing resolver with same name
  const index = FRAMEWORK_RESOLVERS.findIndex((r) => r.name === resolver.name);
  if (index !== -1) {
    FRAMEWORK_RESOLVERS.splice(index, 1);
  }
  FRAMEWORK_RESOLVERS.push(resolver);
}

// Re-export framework resolvers
export { laravelResolver, FACADE_MAPPINGS } from './laravel';
export { expressResolver } from './express';
export { reactResolver } from './react';
export { svelteResolver } from './svelte';
export { djangoResolver, flaskResolver, fastapiResolver } from './python';
export { railsResolver } from './ruby';
export { springResolver } from './java';
export { goResolver } from './go';
export { rustResolver } from './rust';
export { aspnetResolver } from './csharp';
export { swiftUIResolver, uikitResolver, vaporResolver } from './swift';
