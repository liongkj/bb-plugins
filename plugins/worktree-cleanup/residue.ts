import { basename } from 'node:path';

const RESIDUE_NAMES = new Set(['.DS_Store', '.eslintcache', '.coverage']);

export function isResidue(path: string): boolean {
  const name = basename(path);
  const segments = path.split('/');
  return RESIDUE_NAMES.has(name)
    || segments.some(segment => ['node_modules', '.pnpm-store', '__pycache__'].includes(segment))
    || (segments.includes('logs') && /^\.__.+\.lock$/u.test(name))
    || name.endsWith('.pyc') || name.endsWith('.swp') || name.endsWith('.swo') || name.endsWith('.tmp') || name.endsWith('~');
}
