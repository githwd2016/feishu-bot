import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeeklySummaryPrompt,
  formatWeeklyReport,
  generateWeeklyReport,
  isWeeklyReportRequest,
  parseGitLog,
  weekRange,
} from '../src/weekly-report.js';

test('weekly report request parser accepts explicit Chinese and English commands', () => {
  assert.equal(isWeeklyReportRequest('总结本周提交'), true);
  assert.equal(isWeeklyReportRequest('总结本周提交，形成周报'), true);
  assert.equal(isWeeklyReportRequest('生成周报'), true);
  assert.equal(isWeeklyReportRequest('weekly commit report'), true);
  assert.equal(isWeeklyReportRequest('这周提交了什么？'), false);
});

test('weekRange starts at Monday midnight in the configured timezone', () => {
  const range = weekRange(new Date('2026-09-04T03:00:00.000Z'), 'Asia/Shanghai');
  assert.equal(range.start.toISOString(), '2026-08-30T16:00:00.000Z');
});

test('generateWeeklyReport only invokes git for configured repositories', async () => {
  const calls = [];
  const report = await generateWeeklyReport({
    'org/repo-a': '/repo/a',
    'org/repo-b': '/repo/b',
  }, {
    now: new Date('2026-09-04T03:00:00.000Z'),
    runGit: async (args) => {
      calls.push(args);
      if (args[1] === '/repo/a') {
        return { stdout: '\x1eabc123\x1fAlice\x1falice@example.com\x1f2026-09-01T10:00:00+08:00\x1ffeature A\n2\t1\tsrc/a.js\n' };
      }
      return { stdout: '' };
    },
  });

  assert.deepEqual(calls.map((args) => args[2]), ['log', 'log']);
  assert.deepEqual(calls.map((args) => args[1]), ['/repo/a', '/repo/b']);
  assert.match(report, /【org\/repo-a】/);
  assert.match(report, /feature A/);
  assert.match(report, /【org\/repo-b】\n本周暂无提交/);
  assert.doesNotMatch(report, /repo-c/);
});

test('parseGitLog extracts commit metadata and numstat totals', () => {
  const commits = parseGitLog('\x1eabcdef\x1fAlice\x1falice@example.com\x1f2026-09-01T10:00:00+08:00\x1ffeature\n3\t2\tfile.js\n-\t-\timage.png\n');
  assert.deepEqual(commits[0], {
    sha: 'abcdef', author: 'Alice', authorEmail: 'alice@example.com', date: '2026-09-01T10:00:00+08:00', subject: 'feature',
    files: ['file.js', 'image.png'], additions: 3, deletions: 2,
  });
});

test('formatWeeklyReport includes repository errors without dropping other repositories', () => {
  const report = formatWeeklyReport({
    range: { start: new Date('2026-08-30T16:00:00.000Z') },
    current: new Date('2026-09-04T03:00:00.000Z'),
    results: [{ repo: 'org/broken', commits: [], error: '不是 Git 仓库' }],
  });
  assert.match(report, /读取失败：不是 Git 仓库/);
});

test('weekly summary prompt requires one themed sentence per configured login', () => {
  const prompt = buildWeeklySummaryPrompt({
    range: { start: new Date('2026-08-30T16:00:00.000Z') },
    current: new Date('2026-09-04T03:00:00.000Z'),
    identities: [{ displayName: '张三', gitcodeLogin: 'zhangsan' }, { displayName: '李四', gitcodeLogin: 'lisi' }],
    results: [{ repo: 'org/repo', commits: [{
      author: 'zhangsan', date: '2026-09-01T10:00:00+08:00', subject: 'fix: login timeout',
      files: ['src/auth.js'], additions: 2, deletions: 1,
    }] }],
  });
  assert.match(prompt, /zhangsan/);
  assert.match(prompt, /lisi/);
  assert.match(prompt, /按提交主题归类/);
  assert.match(prompt, /每个主题只用一句简短的话/);
});
