#!/usr/bin/env node
import fs from 'node:fs/promises';
import { GitCodeClient } from '../src/gitcode-client.js';
import { assertAllowedPr, parsePrUrl } from '../src/pr.js';

const [command, url, ...args] = process.argv.slice(2);
const token = process.env.GITCODE_TOKEN;
if (!token) fail('缺少 GITCODE_TOKEN');
let pr;
try {
  const allowedRepos = new Set(
    String(process.env.GITCODE_ALLOWED_REPOS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  pr = assertAllowedPr(parsePrUrl(url), allowedRepos);
} catch (error) {
  fail(error.message);
}
const client = new GitCodeClient({
  token,
  apiBase: (process.env.GITCODE_API_BASE || 'https://api.gitcode.com/api/v5').replace(/\/$/, ''),
});

try {
  let result;
  switch (command) {
    case 'pr': result = await client.getPr(pr); break;
    case 'files': result = await client.listFiles(pr); break;
    case 'comments': result = await client.listComments(pr); break;
    case 'inline':
      confirmTarget(args, pr);
      result = await client.postInlineComment(pr, {
        path: option(args, '--path'),
        position: positiveInteger(option(args, '--position'), '--position'),
        body: await fs.readFile(option(args, '--body-file'), 'utf8'),
      });
      break;
    case 'reply':
      confirmTarget(args, pr);
      result = await client.reply(
        pr,
        option(args, '--discussion-id'),
        await fs.readFile(option(args, '--body-file'), 'utf8'),
      );
      break;
    case 'resolve':
      confirmTarget(args, pr);
      result = await client.setResolved(pr, option(args, '--discussion-id'), true);
      break;
    default:
      fail('命令必须是 pr、files、comments、inline、reply 或 resolve');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  fail(error.message);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) fail(`缺少参数 ${name}`);
  return argv[index + 1];
}

function confirmTarget(argv, prValue) {
  const target = option(argv, '--confirm-target').toLowerCase();
  if (target !== prValue.key) fail(`写入确认目标不匹配，期望 ${prValue.key}`);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) fail(`${name} 必须是正整数`);
  return number;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
