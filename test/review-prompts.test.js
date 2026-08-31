import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('review prompts use GitCode new-file line positions and permit narrow mispost cleanup', async () => {
  for (const backend of ['codex', 'opencode']) {
    const prompt = await fs.readFile(path.join(projectRoot, 'prompts', backend, 'review.md'), 'utf8');
    assert.match(prompt, /新文件中的绝对行号/);
    assert.match(prompt, /resolve 该误发 discussion/);
    assert.match(prompt, /diff_position\.start_new_line/);
    assert.doesNotMatch(prompt, /<diff-line-position>|传入正确的 `path`、diff-relative `position`/);
  }
});
