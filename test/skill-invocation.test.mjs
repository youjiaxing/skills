import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

import { scanSkills } from '../scripts/link-skills.mjs';

test('所有可发布 skill 的 Codex 配置均禁止自动调用', async (t) => {
  const root = path.resolve(import.meta.dirname, '..', 'skills');
  const skills = await scanSkills(root);
  assert.ok(skills.length > 0);

  for (const skill of skills) {
    await t.test(skill.name, async () => {
      const configPath = path.join(skill.source, 'agents', 'openai.yaml');
      const document = parseDocument(await readFile(configPath, 'utf8'));
      assert.deepEqual(document.errors, [], `${skill.name}: YAML 必须有效`);
      assert.equal(document.toJS()?.policy?.allow_implicit_invocation, false);
    });
  }
});
