// 自定义模型 —— 浏览器半身（client bundle）。
//
// 由 client 模块系统按 package.json 的 `dsh.client` 声明装载：本文件向
// window.__ModuleLoader__ 登记包名与一个 lazy-CJS factory，factory 返回
// { apply, inject }，被 Cordis 当插件对象收养。
//
// 界面只用官方 设置 → 模型 页为仓外插件预留的两个席位：
//   · settings.models.footer          —— 列表，(id: custom-model)：自定义模型总览 / 增删改
//   · settings.models.provider-card   —— keyed，key: llm-pi-ai：每张提供商卡片里的检验面板
// 两者都不改官方代码，样式只用官方 --dsw-alias-* 设计变量，所以深浅色自动跟随。
//
// 所有读写都走本插件 host 半身的 /dsh-custom-model/* 路由：
// host 用 ctx.settings 写 `llm-pi-ai`、用 ctx.credentials 存密钥、用探测引擎问端点。
// 浏览器只画界面 —— 密钥与探测请求都不经过渲染进程。
window.__ModuleLoader__.load({
  id: 'dsh-custom-model',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const inject = ['slots'];

    const React = require('react');
    if (!React || typeof React.createElement !== 'function') {
      console.warn('[custom-model] React 不可用，面板跳过');
      exports.inject = inject;
      exports.apply = () => {};
      return module.exports;
    }
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = '/dsh-custom-model';
    const SETTINGS_NS = 'llm-pi-ai';
    /** 与 host 半身保持一致：写入失败时用来判断是不是 revision 冲突。 */
    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const PROTOCOL_LABELS = {
      'openai-completions': 'OpenAI Chat Completions',
      'openai-responses': 'OpenAI Responses',
      'anthropic-messages': 'Anthropic Messages',
      'google-generative-ai': 'Gemini API',
    };
    const KIND_LABEL = {
      ok: '可用',
      'not-activated': '未开通',
      quota: '额度耗尽',
      'non-chat': '非对话模型',
      rejected: '被拒绝',
      error: '出错',
      pending: '待检',
      catalog: '目录',
    };

    // ── 样式：只用官方设计变量，深浅色自动跟随 ────────────────────────────────
    const STYLES = `
.dscm-root{margin-top:14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:14px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:1.55;overflow:hidden}
.dscm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px}
.dscm-title{font-weight:600;font-size:13px}
.dscm-sub{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;flex:1 1 260px;min-width:180px}
.dscm-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto}
.dscm-btn{height:26px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.dscm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dscm-btn:disabled{opacity:.45;cursor:default}
.dscm-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));border-color:transparent;color:var(--dsw-alias-label-on-color,#fff)}
.dscm-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4d6bfe));opacity:.92}
.dscm-btn-danger{color:var(--dsw-alias-state-error-primary,#d9534f);border-color:var(--dsw-alias-state-error-secondary,rgba(217,83,79,.4))}
.dscm-btn-sm{height:22px;padding:0 8px;font-size:11px;border-radius:6px}
.dscm-body{padding:0 14px 12px;display:flex;flex-direction:column;gap:10px}
.dscm-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.04))}
.dscm-row-main{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 180px}
.dscm-row-url{flex:1 1 100%;min-width:0}
.dscm-row:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.07))}
.dscm-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#9aa4ad)}
.dscm-dot-ok{background:var(--dsw-alias-state-success-primary,#2fbf71)}
.dscm-dot-warn{background:var(--dsw-alias-state-warn-primary,#e0a800)}
.dscm-dot-bad{background:var(--dsw-alias-state-error-primary,#d9534f)}
.dscm-id{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,Consolas,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dscm-name{color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dscm-url{color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,Consolas,monospace);font-size:11px}
.dscm-mini{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dscm-tag{display:inline-block;padding:0 7px;border-radius:999px;font-size:10px;line-height:16px;background:var(--dsw-alias-button-elevated-fill,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,inherit);margin-left:6px}
.dscm-tag-ok{background:var(--dsw-alias-state-success-tertiary,rgba(47,191,113,.16));color:var(--dsw-alias-state-success-primary,#2fbf71)}
.dscm-tag-bad{background:var(--dsw-alias-state-error-secondary,rgba(217,83,79,.16));color:var(--dsw-alias-state-error-primary,#d9534f)}
.dscm-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:12px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}
.dscm-field{display:flex;flex-direction:column;gap:4px}
.dscm-field-wide{grid-column:1 / -1}
.dscm-label{color:var(--dsw-alias-label-secondary,inherit);font-size:11px}
.dscm-input,.dscm-select{height:28px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.04));color:inherit;font:inherit;font-size:12px;min-width:0}
.dscm-input:focus,.dscm-select:focus{outline:none;border-color:var(--dsw-alias-border-selected,var(--dsw-alias-brand-primary,#4d6bfe))}
.dscm-hint{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary,inherit));font-size:11px}
.dscm-ops{grid-column:1 / -1;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dscm-actions-start{margin-left:0;justify-content:flex-start}
.dscm-err{color:var(--dsw-alias-state-error-primary,#d9534f);font-size:11px}
.dscm-ok{color:var(--dsw-alias-state-success-primary,#2fbf71);font-size:11px}
.dscm-warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b7791f));font-size:11px}
.dscm-table{width:100%;border-collapse:collapse;font-size:11px}
.dscm-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,inherit);padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));white-space:nowrap}
.dscm-table td{padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1));vertical-align:middle}
.dscm-table tr:last-child td{border-bottom:0}
.dscm-cell-input{height:24px;padding:0 6px;font-size:11px;width:100%}
.dscm-scroll{max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:10px}
.dscm-bar{height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));overflow:hidden}
.dscm-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary,#4d6bfe);transition:width .3s}
.dscm-sum{display:flex;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary,inherit);font-size:11px}
.dscm-sum b{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.dscm-empty{padding:10px 2px;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}
.dscm-card{margin-top:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;background:var(--dsw-alias-bg-overlay,transparent);overflow:hidden}
.dscm-card-head{display:flex;align-items:center;gap:8px;width:100%;padding:7px 11px;background:transparent;border:0;cursor:pointer;color:inherit;font:inherit;text-align:left}
.dscm-card-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dscm-card-body{padding:0 11px 10px;display:flex;flex-direction:column;gap:8px}
.dscm-chev{margin-left:auto;opacity:.6;font-size:10px}
.dscm-log{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,Consolas,monospace);font-size:10px;color:var(--dsw-alias-label-tertiary,inherit);white-space:pre-wrap;max-height:90px;overflow:auto}
.dscm-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}
.dscm-tabs{display:flex;gap:6px}
.dscm-tab{padding:0 10px;height:22px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;font:inherit;font-size:11px}
.dscm-tab-on{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.4));background:var(--dsw-alias-button-elevated-fill,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}
.dscm-split{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
`;

    function installStyles() {
      try {
        if (document.getElementById('dscm-styles')) return;
        const el = document.createElement('style');
        el.id = 'dscm-styles';
        el.textContent = STYLES;
        (document.head || document.documentElement).appendChild(el);
      } catch {
        /* 样式是装饰性的，失败不影响功能 */
      }
    }

    // ── 抓取与状态仓库 ────────────────────────────────────────────────────────
    async function request(path, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      let res;
      try {
        res = await fetch(API + path, init);
      } catch (error) {
        return { ok: false, error: '连不上 host 半身：' + ((error && error.message) || error) };
      }
      let data;
      try {
        data = await res.json();
      } catch {
        return { ok: false, error: 'HTTP ' + res.status };
      }
      if (data === null || typeof data !== 'object') return { ok: false, error: 'HTTP ' + res.status };
      return data;
    }

    const store = {
      snapshot: null,
      loading: false,
      error: null,
      /** providerId → { jobId, state, total, finished, results, log, catalog, mode, error } */
      probes: {},
      listeners: new Set(),
    };

    function notify() {
      for (const listener of [...store.listeners]) {
        try {
          listener();
        } catch {
          /* 单个订阅者出错不影响其它 */
        }
      }
    }

    function useStore() {
      const [, force] = useState(0);
      useEffect(() => {
        const listener = () => force((n) => n + 1);
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      }, []);
      return store;
    }

    async function refresh() {
      store.loading = true;
      notify();
      const data = await request('/state');
      store.loading = false;
      if (data.ok) {
        store.snapshot = data;
        store.error = null;
      } else {
        store.error = data.error || '读取配置失败';
      }
      notify();
      return data;
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** 轮询一个探测作业直到它离开 running。 */
    async function pollJob(providerId, jobId) {
      for (let round = 0; round < 4000; round += 1) {
        await sleep(900);
        const data = await request('/probe/status?id=' + encodeURIComponent(jobId));
        if (!data.ok) {
          const job = store.probes[providerId];
          if (job !== undefined) {
            job.state = 'error';
            job.error = data.error;
          }
          notify();
          return;
        }
        const job = store.probes[providerId] || {};
        job.jobId = jobId;
        job.state = data.state;
        job.total = data.total;
        job.finished = data.finished;
        job.results = data.results || [];
        job.log = data.log || [];
        job.catalog = data.catalog;
        job.mode = data.mode;
        job.error = data.error;
        store.probes[providerId] = job;
        notify();
        if (data.state !== 'running') return;
      }
    }

    async function startProbe(provider, mode) {
      if (provider === undefined || provider === null) return;
      const models = (provider.models || []).map((m) => m.id).filter(Boolean);
      if (models.length === 0 && provider.custom === true) {
        store.probes[provider.id] = {
          state: 'error',
          error: '这条自定义路由还没有模型清单：先编辑并加入模型，再检验',
          results: [],
        };
        notify();
        return;
      }
      store.probes[provider.id] = {
        state: 'starting',
        mode,
        total: models.length,
        finished: 0,
        results: [],
        log: [],
      };
      notify();
      const data = await request('/probe/start', {
        provider: provider.id,
        baseURL: provider.baseURL,
        api: provider.api,
        apiKeyEnv: provider.key ? provider.key.ref : undefined,
        models,
        mode,
      });
      if (!data.ok) {
        store.probes[provider.id] = { state: 'error', error: data.error, results: [] };
        notify();
        return;
      }
      await pollJob(provider.id, data.jobId);
    }

    async function applyProbe(provider, revision, mark) {
      const job = store.probes[provider.id];
      if (job === undefined || !Array.isArray(job.results) || job.results.length === 0) return;
      const rows = job.results
        .filter((row) => row && row.id)
        .map((row) => ({
          id: row.id,
          contextWindow: row.contextWindow,
          maxTokens: row.maxTokens,
          reasoningEfforts: row.efforts === false ? false : (row.efforts !== null && typeof row.efforts === 'object' ? row.efforts : undefined),
        }));
      const data = await request('/probe/apply', { provider: provider.id, rows, revision });
      mark(data.ok ? { ok: '已把 ' + (data.written || 0) + ' 项能力值写回配置' } : { error: data.error });
      if (data.ok) {
        if (data.providers) store.snapshot = { ...store.snapshot, providers: data.providers, revision: data.revision };
        notify();
      }
    }

    // ── 小工具 ───────────────────────────────────────────────────────────────
    function fmtNum(value) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '—';
      if (value >= 1000000) return (value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1) + 'M';
      if (value >= 1000) return (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1) + 'k';
      return String(value);
    }

    function jobDot(job) {
      if (job === undefined) return '';
      if (job.state === 'running' || job.state === 'starting') return '';
      const results = job.results || [];
      if (results.length === 0) return job.state === 'error' ? ' dscm-dot-bad' : '';
      const bad = results.filter((r) => r.alive === false).length;
      if (bad === 0) return ' dscm-dot-ok';
      return bad === results.length ? ' dscm-dot-bad' : ' dscm-dot-warn';
    }

    function summarize(results) {
      const groups = { ok: 0, off: 0, quota: 0, bad: 0, idle: 0 };
      for (const row of results || []) {
        if (row.kind === 'ok') groups.ok += 1;
        else if (row.alive === false) {
          if (row.kind === 'not-activated') groups.off += 1;
          else if (row.kind === 'quota') groups.quota += 1;
          else groups.bad += 1;
        } else if (row.kind === 'pending') groups.idle += 1;
        else groups.bad += 1;
      }
      return groups;
    }

    function shortMessage(row) {
      if (row === undefined || row === null) return '';
      if (row.kind === 'ok') return row.status !== undefined ? 'HTTP ' + row.status : '可用';
      const msg = row.message || row.error || '';
      return KIND_LABEL[row.kind] ? KIND_LABEL[row.kind] + (msg ? '：' + msg : '') : msg;
    }

    function effortsText(row) {
      if (row === undefined || row === null) return '—';
      if (row.efforts === false || row.reasoning === false) return '不推理';
      if (row.efforts !== null && typeof row.efforts === 'object' && Object.keys(row.efforts).length > 0) {
        return Object.keys(row.efforts).join(' / ');
      }
      return '—';
    }

    /** 把 "low, high, off:none" 解析成配置里的 reasoningEfforts 字典。 */
    function parseEfforts(text) {
      const tokens = String(text || '').split(/[,\uFF0C\s]+/).filter(Boolean);
      if (tokens.length === 0) return undefined;
      const out = {};
      for (const token of tokens) {
        const [level, wire] = token.split(':');
        if (LEVELS.indexOf(level) < 0) continue;
        out[level] = wire && wire.length > 0 ? wire : (level === 'off' ? 'none' : level);
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }

    function effortsToText(efforts) {
      if (efforts === false) return '';
      if (efforts === null || typeof efforts !== 'object') return '';
      return Object.entries(efforts)
        .map(([level, wire]) => (wire === level ? level : level + ':' + wire))
        .join(', ');
    }

    // ── 探测面板（两个席位共用） ──────────────────────────────────────────────
    function ProbeArea(props) {
      const { provider, revision, compact } = props;
      const job = props.job;
      const [showLog, setShowLog] = useState(false);
      const [filter, setFilter] = useState('all');
      const [mark, setMark] = useState(null);
      // 用户要的是「检验完就写进配置」，所以默认打开；想只看不动配置时取消勾选。
      const [autoApply, setAutoApply] = useState(true);
      const run = async (mode) => {
        setMark(null);
        await startProbe(provider, mode);
        if (!autoApply) return;
        const done = store.probes[provider.id];
        const hasCapability = done !== undefined && Array.isArray(done.results)
          && done.results.some((row) => row.contextWindow !== undefined || row.maxTokens !== undefined || row.efforts !== undefined);
        if (hasCapability) await applyProbe(provider, revision, setMark);
      };
      const results = (job && job.results) || [];
      const groups = summarize(results);
      const running = job !== undefined && (job.state === 'running' || job.state === 'starting');
      const pct = job !== undefined && job.total > 0 ? Math.round(((job.finished || 0) / job.total) * 100) : 0;
      const visible = results.filter((row) => {
        if (filter === 'ok') return row.kind === 'ok';
        if (filter === 'bad') return row.alive === false;
        return true;
      });

      const buttons = h('div', { className: 'dscm-actions dscm-actions-start' }, [
        h('button', {
          key: 'quick',
          type: 'button',
          className: 'dscm-btn dscm-btn-sm',
          disabled: running,
          onClick: () => run('alive'),
        }, '快速检验'),
        h('button', {
          key: 'full',
          type: 'button',
          className: 'dscm-btn dscm-btn-sm',
          disabled: running,
          onClick: () => run('full'),
        }, '完整检验'),
        job !== undefined && !running && results.length > 0
          ? h('button', {
            key: 'apply',
            type: 'button',
            className: 'dscm-btn dscm-btn-sm',
            onClick: () => { setMark(null); applyProbe(provider, revision, setMark); },
          }, '写回配置')
          : null,
        running
          ? h('button', {
            key: 'stop',
            type: 'button',
            className: 'dscm-btn dscm-btn-sm dscm-btn-danger',
            onClick: async () => { await request('/probe/cancel', { id: job.jobId }); },
          }, '停止')
          : null,
        h('label', { key: 'auto', className: 'dscm-check', title: '检验完成后自动把上下文窗口 / 输出上限 / 推理档位写进配置' }, [
          h('input', {
            type: 'checkbox',
            checked: autoApply,
            onChange: (event) => setAutoApply(event.target.checked),
          }),
          '检验后自动写入配置',
        ]),
      ]);

      return h('div', { className: compact ? 'dscm-card-body' : 'dscm-body' }, [
        buttons,
        running
          ? h('div', { key: 'bar', className: 'dscm-bar' }, [h('i', { style: { width: pct + '%' } })])
          : null,
        running
          ? h('div', { key: 'prog', className: 'dscm-mini' }, '已检 ' + (job.finished || 0) + '/' + (job.total || 0))
          : null,
        job !== undefined && job.error
          ? h('div', { key: 'jerr', className: 'dscm-err' }, '检验错误：' + job.error)
          : null,
        mark !== null && mark.ok ? h('div', { key: 'mok', className: 'dscm-ok' }, mark.ok) : null,
        mark !== null && mark.error ? h('div', { key: 'merr', className: 'dscm-err' }, mark.error) : null,
        results.length > 0
          ? h('div', { key: 'sum', className: 'dscm-sum' }, [
            h('span', { key: 'a' }, ['完成 ', h('b', { key: '1' }, (job.finished || 0) + '/' + (job.total || 0))]),
            h('span', { key: 'b' }, ['可用 ', h('b', { key: '2' }, String(groups.ok))]),
            h('span', { key: 'c' }, ['未开通 ', h('b', { key: '3' }, String(groups.off))]),
            h('span', { key: 'd' }, ['额度不足 ', h('b', { key: '4' }, String(groups.quota))]),
            h('span', { key: 'e' }, ['其它异常 ', h('b', { key: '5' }, String(groups.bad))]),
            job !== undefined && job.catalog && job.catalog.loaded
              ? h('span', { key: 'f' }, ['厂商目录 ', h('b', { key: '6' }, String(job.catalog.count) + ' 个')])
              : null,
          ])
          : null,
        results.length > 0
          ? h('div', { key: 'tabs', className: 'dscm-tabs' }, [
            h('button', { key: 'all', type: 'button', className: 'dscm-tab' + (filter === 'all' ? ' dscm-tab-on' : ''), onClick: () => setFilter('all') }, '全部'),
            h('button', { key: 'ok', type: 'button', className: 'dscm-tab' + (filter === 'ok' ? ' dscm-tab-on' : ''), onClick: () => setFilter('ok') }, '仅可用'),
            h('button', { key: 'bad', type: 'button', className: 'dscm-tab' + (filter === 'bad' ? ' dscm-tab-on' : ''), onClick: () => setFilter('bad') }, '仅异常'),
          ])
          : null,
        results.length > 0
          ? h('div', { key: 'list', className: 'dscm-scroll' }, h('table', { className: 'dscm-table' }, [
            h('thead', { key: 'h' }, h('tr', null, [
              h('th', { key: 'i' }, '模型'),
              h('th', { key: 'c' }, '上下文'),
              h('th', { key: 'm' }, '输出上限'),
              h('th', { key: 'r' }, '推理档位'),
              h('th', { key: 's' }, '状态'),
            ])),
            h('tbody', { key: 'b' }, visible.map((row) => h('tr', { key: row.id }, [
              h('td', { key: 'i', className: 'dscm-id', title: row.id }, row.id),
              h('td', { key: 'c' }, fmtNum(row.contextWindow)),
              h('td', { key: 'm' }, fmtNum(row.maxTokens)),
              h('td', { key: 'r' }, effortsText(row)),
              h('td', { key: 's', className: row.alive === false ? 'dscm-err' : 'dscm-mini', title: shortMessage(row) }, shortMessage(row) || '—'),
            ]))),
          ]))
          : null,
        h('button', {
          key: 'log',
          type: 'button',
          className: 'dscm-btn dscm-btn-sm',
          style: { alignSelf: 'flex-start' },
          onClick: () => setShowLog((v) => !v),
        }, showLog ? '收起日志' : '查看日志'),
        showLog
          ? h('div', { key: 'logbody', className: 'dscm-log' }, ((job && job.log) || []).join('\n') || '（暂无日志）')
          : null,
      ]);
    }

    /** 提供商卡片里的检验入口：默认收起，点开才渲染明细。 */
    function ProviderCardPanel(ownerProps) {
      const snapshot = useStore();
      const [open, setOpen] = useState(false);
      const providerId = ownerProps && ownerProps.provider ? ownerProps.provider.provider : undefined;
      const provider = (snapshot.snapshot && snapshot.snapshot.providers || []).find((row) => row.id === providerId);
      const job = providerId !== undefined ? snapshot.probes[providerId] : undefined;
      const models = provider ? (provider.models || []).length : 0;

      // 卡片可能先于总览挂载（官方页先渲染卡片）：自己补一次读取，避免"未声明模型"的假象。
      useEffect(() => {
        installStyles();
        if (store.snapshot === null && store.loading === false) refresh();
      }, []);

      // 只给「自己声明 / 改过」的提供商卡片加检验条：官方那 40 多条内置卡片保持原样，
      // 内置路由要检验时走总览的「显示内置」。
      if (provider === undefined || provider.custom !== true) return null;
      const summary = job !== undefined && job.results && job.results.length > 0
        ? summarize(job.results)
        : null;

      return h('div', { className: 'dscm-card' }, [
        h('button', {
          key: 'head',
          type: 'button',
          className: 'dscm-card-head',
          onClick: () => setOpen((v) => !v),
        }, [
          h('span', { key: 'd', className: 'dscm-dot' + jobDot(job) }),
          h('span', { key: 't', className: 'dscm-title' }, '模型检验'),
          h('span', { key: 's', className: 'dscm-mini' }, summary !== null
            ? '可用 ' + summary.ok + ' / ' + (job.total || 0) + (job.mode === 'full' ? ' · 完整检验' : ' · 快速筛查')
            : models > 0 ? models + ' 个模型' : '模型清单在内置目录'),
          h('span', { key: 'c', className: 'dscm-chev' }, open ? '收起' : '展开'),
        ]),
        open && provider !== undefined ? h(ProbeArea, { key: 'body', provider, revision: snapshot.snapshot.revision, job, compact: true }) : null,
      ]);
    }

    // ── 模型行编辑器 ─────────────────────────────────────────────────────────
    function ModelTable(props) {
      const { models, onChange } = props;
      const update = (index, patch) => {
        const next = models.map((row, i) => (i === index ? { ...row, ...patch } : row));
        onChange(next);
      };
      return h('div', { className: 'dscm-scroll' }, h('table', { className: 'dscm-table' }, [
        h('thead', { key: 'h' }, h('tr', null, [
          h('th', { key: 'i', style: { minWidth: 150 } }, '模型 id'),
          h('th', { key: 'n', style: { minWidth: 110 } }, '显示名'),
          h('th', { key: 'c', style: { width: 90 } }, '上下文'),
          h('th', { key: 'm', style: { width: 90 } }, '输出上限'),
          h('th', { key: 'r', style: { minWidth: 150 } }, '推理档位'),
          h('th', { key: 'x', style: { width: 36 } }, ''),
        ])),
        h('tbody', { key: 'b' }, models.map((row, index) => h('tr', { key: index }, [
          h('td', { key: 'i' }, h('input', {
            className: 'dscm-input dscm-cell-input',
            value: row.id || '',
            placeholder: '例如 qwen3.8-max',
            onChange: (event) => update(index, { id: event.target.value }),
          })),
          h('td', { key: 'n' }, h('input', {
            className: 'dscm-input dscm-cell-input',
            value: row.name || '',
            placeholder: '可选',
            onChange: (event) => update(index, { name: event.target.value }),
          })),
          h('td', { key: 'c' }, h('input', {
            className: 'dscm-input dscm-cell-input',
            value: row.contextWindow === undefined ? '' : String(row.contextWindow),
            placeholder: '1000000',
            inputMode: 'numeric',
            onChange: (event) => update(index, { contextWindow: event.target.value === '' ? undefined : Number(event.target.value) }),
          })),
          h('td', { key: 'm' }, h('input', {
            className: 'dscm-input dscm-cell-input',
            value: row.maxTokens === undefined ? '' : String(row.maxTokens),
            placeholder: '65536',
            inputMode: 'numeric',
            onChange: (event) => update(index, { maxTokens: event.target.value === '' ? undefined : Number(event.target.value) }),
          })),
          h('td', { key: 'r' }, h('input', {
            className: 'dscm-input dscm-cell-input',
            value: effortsToText(row.reasoningEfforts),
            placeholder: '留空=不推理，如 low,medium,high',
            onChange: (event) => update(index, { reasoningEfforts: parseEfforts(event.target.value) || false }),
          })),
          h('td', { key: 'x' }, h('button', {
            type: 'button',
            className: 'dscm-btn dscm-btn-sm dscm-btn-danger',
            title: '移除该模型',
            onClick: () => onChange(models.filter((_, i) => i !== index)),
          }, '✕')),
        ]))),
      ]));
    }

    // ── 编辑器 ───────────────────────────────────────────────────────────────
    function Editor(props) {
      const { initial, protocols, revision, onDone, onCancel } = props;
      const rootRef = useRef(null);
      // 编辑器很长，打开后先把它滚进视野，否则在小窗口里只看到第一行。
      useEffect(() => {
        try {
          if (rootRef.current && typeof rootRef.current.scrollIntoView === 'function') {
            rootRef.current.scrollIntoView({ block: 'nearest' });
          }
        } catch {
          /* 滚动只是体验优化 */
        }
      }, []);
      const isNew = initial === null || initial === undefined;
      const [id, setId] = useState(isNew ? '' : initial.id);
      const [displayName, setDisplayName] = useState(isNew ? '' : initial.displayName);
      const [api, setApi] = useState(isNew ? protocols[0] : (initial.api || protocols[0]));
      const [baseURL, setBaseURL] = useState(isNew ? '' : initial.baseURL);
      const [apiKeyEnv, setApiKeyEnv] = useState(isNew ? '' : (initial.key ? initial.key.ref : ''));
      const [apiKey, setApiKey] = useState('');
      const [models, setModels] = useState(isNew ? [] : (initial.models || []).map((row) => ({ ...row })));
      const [busy, setBusy] = useState(false);
      const [mark, setMark] = useState(null);
      const [candidates, setCandidates] = useState(null);
      const [picked, setPicked] = useState({});
      const [search, setSearch] = useState('');

      const save = async () => {
        setBusy(true);
        setMark(null);
        const data = await request('/provider/save', {
          id,
          originalId: isNew ? undefined : initial.id,
          displayName,
          api,
          baseURL,
          apiKeyEnv,
          apiKey: apiKey.length > 0 ? apiKey : undefined,
          models: models.map((row) => ({
            id: row.id,
            name: row.name,
            contextWindow: row.contextWindow,
            maxTokens: row.maxTokens,
            reasoningEfforts: row.reasoningEfforts,
          })),
          revision,
        });
        setBusy(false);
        if (!data.ok) {
          setMark({ error: data.error });
          return;
        }
        await refresh();
        onDone();
      };

      const discover = async () => {
        setBusy(true);
        setMark(null);
        const data = await request('/models/discover', {
          provider: isNew ? undefined : initial.id,
          baseURL,
          api,
          apiKey: apiKey.length > 0 ? apiKey : undefined,
          apiKeyEnv: apiKeyEnv.length > 0 ? apiKeyEnv : undefined,
        });
        setBusy(false);
        if (!data.ok) {
          setMark({ error: data.error });
          return;
        }
        const list = data.models || [];
        const preset = {};
        for (const row of models) if (row.id) preset[row.id] = true;
        setPicked(Object.keys(preset).length > 0 ? preset : Object.fromEntries(list.map((m) => [m.id, true])));
        setCandidates(list);
        setMark({ ok: '端点公布了 ' + list.length + ' 个模型，勾选后点「更新清单」' });
      };

      const adoptCandidates = () => {
        const list = candidates || [];
        const chosen = list.filter((m) => picked[m.id] === true);
        const byId = new Map(models.map((row) => [row.id, row]));
        const next = chosen.map((m) => {
          const existing = byId.get(m.id);
          if (existing !== undefined) return existing;
          return {
            id: m.id,
            name: m.name,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            reasoningEfforts: false,
          };
        });
        // 未出现在回复里的已配置模型保留（与官方页一致）。
        for (const row of models) {
          if (row.id && !chosen.some((m) => m.id === row.id) && !list.some((m) => m.id === row.id)) next.push(row);
        }
        setModels(next);
        setCandidates(null);
      };

      const visibleCandidates = (candidates || []).filter((m) => {
        if (search.trim().length === 0) return true;
        const needle = search.trim().toLowerCase();
        return m.id.toLowerCase().includes(needle) || String(m.name || '').toLowerCase().includes(needle);
      });

      return h('div', { className: 'dscm-form', ref: rootRef }, [
        h('div', { key: 'id', className: 'dscm-field' }, [
          h('span', { className: 'dscm-label' }, 'Provider ID（配置键，保存后不改）'),
          h('input', {
            className: 'dscm-input',
            value: id,
            placeholder: '例如 qwen-gateway',
            onChange: (event) => setId(event.target.value.trim()),
          }),
        ]),
        h('div', { key: 'name', className: 'dscm-field' }, [
          h('span', { className: 'dscm-label' }, '显示名（模型选择器里看到的）'),
          h('input', {
            className: 'dscm-input',
            value: displayName,
            placeholder: '例如 通义千问中转',
            onChange: (event) => setDisplayName(event.target.value),
          }),
        ]),
        h('div', { key: 'api', className: 'dscm-field' }, [
          h('span', { className: 'dscm-label' }, 'API 协议'),
          h('select', {
            className: 'dscm-select',
            value: api,
            onChange: (event) => setApi(event.target.value),
          }, protocols.map((value) => h('option', { key: value, value }, PROTOCOL_LABELS[value] || value))),
        ]),
        h('div', { key: 'url', className: 'dscm-field' }, [
          h('span', { className: 'dscm-label' }, '端点地址（baseURL）'),
          h('input', {
            className: 'dscm-input',
            value: baseURL,
            placeholder: 'https://gateway.example/v1',
            onChange: (event) => setBaseURL(event.target.value),
          }),
          h('span', { className: 'dscm-hint' }, 'Anthropic 协议填到域名即可（SDK 自己加 /v1/messages）；Gemini 填到 /v1beta'),
        ]),
        h('div', { key: 'keyref', className: 'dscm-field' }, [
          h('span', { className: 'dscm-label' }, '密钥引用名（凭据变量名）'),
          h('input', {
            className: 'dscm-input',
            value: apiKeyEnv,
            placeholder: isNew ? '留空则按 Provider ID 生成' : '',
            onChange: (event) => setApiKeyEnv(event.target.value),
          }),
        ]),
        h('div', { key: 'key', className: 'dscm-field' }, [
          h('span', { className: 'dscm-label' }, 'API 密钥'),
          h('input', {
            className: 'dscm-input',
            type: 'password',
            value: apiKey,
            placeholder: isNew
              ? '粘贴密钥（只写不读，存进凭据库）'
              : (initial && initial.key && initial.key.configured ? '已保存；留空则保持不变' : '尚未保存'),
            onChange: (event) => setApiKey(event.target.value),
          }),
        ]),
        h('div', { key: 'models', className: 'dscm-field dscm-field-wide' }, [
          h('div', { className: 'dscm-split' }, [
            h('span', { className: 'dscm-label' }, '模型清单（' + models.length + ' 个）'),
            h('div', { className: 'dscm-actions' }, [
              h('button', {
                key: 'discover',
                type: 'button',
                className: 'dscm-btn dscm-btn-sm',
                disabled: busy || baseURL.trim().length === 0,
                onClick: discover,
              }, '获取可用模型'),
              h('button', {
                key: 'add',
                type: 'button',
                className: 'dscm-btn dscm-btn-sm',
                onClick: () => setModels([...models, { id: '', name: '', reasoningEfforts: false }]),
              }, '＋ 加一个'),
            ]),
          ]),
          models.length > 0
            ? h(ModelTable, { models, onChange: setModels })
            : h('div', { className: 'dscm-empty' }, '还没有模型。可以点「获取可用模型」自动带入，或手工「＋ 加一个」。'),
        ]),
        candidates !== null
          ? h('div', { key: 'cand', className: 'dscm-field dscm-field-wide' }, [
            h('div', { className: 'dscm-split' }, [
              h('input', {
                className: 'dscm-input',
                style: { maxWidth: 260 },
                value: search,
                placeholder: '搜索模型 id 或名称',
                onChange: (event) => setSearch(event.target.value),
              }),
              h('div', { className: 'dscm-actions' }, [
                h('button', {
                  key: 'all',
                  type: 'button',
                  className: 'dscm-btn dscm-btn-sm',
                  onClick: () => setPicked(Object.fromEntries(visibleCandidates.map((m) => [m.id, true]))),
                }, '全选'),
                h('button', {
                  key: 'none',
                  type: 'button',
                  className: 'dscm-btn dscm-btn-sm',
                  onClick: () => setPicked({}),
                }, '取消全选'),
                h('button', {
                  key: 'adopt',
                  type: 'button',
                  className: 'dscm-btn dscm-btn-sm dscm-btn-primary',
                  onClick: adoptCandidates,
                }, '更新清单'),
                h('button', {
                  key: 'close',
                  type: 'button',
                  className: 'dscm-btn dscm-btn-sm',
                  onClick: () => setCandidates(null),
                }, '关闭'),
              ]),
            ]),
            h('div', { className: 'dscm-scroll' }, h('table', { className: 'dscm-table' }, [
              h('thead', { key: 'h' }, h('tr', null, [
                h('th', { key: 'c', style: { width: 32 } }, ''),
                h('th', { key: 'i' }, '模型 id'),
                h('th', { key: 'n' }, '名称'),
                h('th', { key: 'w' }, '上下文'),
                h('th', { key: 'm' }, '输出上限'),
              ])),
              h('tbody', { key: 'b' }, visibleCandidates.map((m) => h('tr', { key: m.id }, [
                h('td', { key: 'c' }, h('input', {
                  type: 'checkbox',
                  checked: picked[m.id] === true,
                  onChange: (event) => setPicked({ ...picked, [m.id]: event.target.checked }),
                })),
                h('td', { key: 'i', className: 'dscm-id', title: m.id }, m.id),
                h('td', { key: 'n', className: 'dscm-mini' }, m.name || ''),
                h('td', { key: 'w' }, fmtNum(m.contextWindow)),
                h('td', { key: 'm' }, fmtNum(m.maxTokens)),
              ]))),
            ])),
          ])
          : null,
        mark !== null && mark.ok ? h('div', { key: 'ok', className: 'dscm-field dscm-field-wide dscm-ok' }, mark.ok) : null,
        mark !== null && mark.error ? h('div', { key: 'err', className: 'dscm-field dscm-field-wide dscm-err' }, mark.error) : null,
        h('div', { key: 'ops', className: 'dscm-ops' }, [
          h('button', {
            key: 'save',
            type: 'button',
            className: 'dscm-btn dscm-btn-primary',
            disabled: busy,
            onClick: save,
          }, busy ? '保存中…' : '保存'),
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dscm-btn',
            disabled: busy,
            onClick: onCancel,
          }, '取消'),
          h('span', { key: 'hint', className: 'dscm-hint' }, '保存即写入官方「设置 → 模型」的同一份配置：官方页与这里看到的是同一份数据。'),
        ]),
      ]);
    }

    // ── 总览（footer 席位） ──────────────────────────────────────────────────
    function FooterPanel() {
      const snapshot = useStore();
      const [editing, setEditing] = useState(null); // { mode:'new' } | { mode:'edit', provider }
      const [mark, setMark] = useState(null);
      const [importing, setImporting] = useState(false);
      const [importText, setImportText] = useState('');
      const [busy, setBusy] = useState(false);
      const [showBuiltin, setShowBuiltin] = useState(false);
      const [openProbes, setOpenProbes] = useState({});
      const [enriching, setEnriching] = useState(null);
      const loadedRef = useRef(false);

      useEffect(() => {
        if (loadedRef.current) return;
        loadedRef.current = true;
        installStyles();
        refresh();
      }, []);

      const data = snapshot.snapshot;
      const providers = (data && data.providers) || [];
      const customProviders = providers.filter((row) => row.custom === true);
      const listed = showBuiltin ? providers : customProviders;
      const protocols = (data && data.protocols) || Object.keys(PROTOCOL_LABELS);
      const running = providers.some((row) => {
        const job = snapshot.probes[row.id];
        return job !== undefined && (job.state === 'running' || job.state === 'starting');
      });

      const probeAll = async () => {
        for (const provider of listed) {
          if ((provider.models || []).length === 0) continue;
          await startProbe(provider, 'alive');
        }
      };

      // 自动补全：目录 + 端点档位枚举（1~2 次请求），实测到的上下文窗口 / 输出上限 /
      // 推理档位直接写进官方配置 —— 不用再手工填「上下文窗口 / 最大输出 token / 推理等级」。
      const autoFill = async (provider) => {
        if (provider === undefined || provider.baseURL === undefined || provider.baseURL.length === 0) {
          setMark({ error: '这条提供商还没有端点地址' });
          return;
        }
        setMark(null);
        setEnriching(provider.id);
        const res = await request('/provider/enrich', {
          provider: provider.id,
          revision: snapshot.snapshot ? snapshot.snapshot.revision : undefined,
        });
        setEnriching(null);
        if (!res.ok) {
          setMark({ error: res.error || '自动补全失败' });
          return;
        }
        setMark({ ok: (res.message ? res.message + '：' : '') + '已写入 ' + (res.written || 0) + ' 项能力值' });
        if (res.providers) {
          store.snapshot = { ...store.snapshot, providers: res.providers, revision: res.revision };
        }
        notify();
      };

      const autoFillAll = async () => {
        const targets = listed.filter((provider) => provider.baseURL && provider.baseURL.length > 0);
        let ok = 0;
        let failed = 0;
        for (const provider of targets) {
          setEnriching(provider.id);
          const res = await request('/provider/enrich', { provider: provider.id });
          if (res.ok) ok += 1;
          else failed += 1;
          if (res.ok && res.providers) {
            store.snapshot = { ...store.snapshot, providers: res.providers, revision: res.revision };
            notify();
          }
        }
        setEnriching(null);
        setMark(failed === 0
          ? { ok: `已自动补全 ${ok} 条提供商的能力值` }
          : { error: `自动补全完成：成功 ${ok}，失败 ${failed}` });
        await refresh();
      };

      const remove = async (provider) => {
        const ok = typeof window.confirm === 'function'
          ? window.confirm('删除提供商「' + provider.id + '」？官方「设置 → 模型」里会同时消失。')
          : true;
        if (!ok) return;
        setBusy(true);
        const res = await request('/provider/remove', { id: provider.id, revision: data ? data.revision : undefined });
        setBusy(false);
        if (!res.ok) {
          setMark({ error: res.error });
          return;
        }
        setMark({ ok: '已删除 ' + provider.id });
        await refresh();
      };

      const exportJson = async () => {
        const payload = {
          settingsNs: SETTINGS_NS,
          exportedAt: new Date().toISOString(),
          providers: providers.map((row) => ({
            id: row.id,
            displayName: row.displayName,
            api: row.api,
            baseURL: row.baseURL,
            apiKeyEnv: row.key ? row.key.ref : undefined,
            models: row.models,
          })),
        };
        const text = JSON.stringify(payload, null, 2);
        try {
          await navigator.clipboard.writeText(text);
          setMark({ ok: '已把 ' + providers.length + ' 条提供商复制到剪贴板（密钥不在其中）' });
        } catch {
          setImportText(text);
          setImporting(true);
          setMark({ ok: '剪贴板不可用，已放进下面的导入框，可自行复制保存' });
        }
      };

      const importJson = async () => {
        let parsed;
        try {
          parsed = JSON.parse(importText);
        } catch (error) {
          setMark({ error: 'JSON 解析失败：' + ((error && error.message) || error) });
          return;
        }
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.providers) ? parsed.providers : null);
        if (list === null) {
          setMark({ error: '期望一个 { providers: [...] } 或直接是数组' });
          return;
        }
        setBusy(true);
        let done = 0;
        let failed = 0;
        for (const row of list) {
          if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue;
          const res = await request('/provider/save', {
            id: row.id,
            displayName: row.displayName,
            api: row.api,
            baseURL: row.baseURL,
            apiKeyEnv: row.apiKeyEnv,
            models: Array.isArray(row.models) ? row.models : undefined,
            revision: undefined,
          });
          if (res.ok) done += 1;
          else failed += 1;
        }
        setBusy(false);
        setImporting(false);
        setImportText('');
        setMark(failed === 0 ? { ok: '已导入 ' + done + ' 条提供商' } : { error: '导入完成：成功 ' + done + '，失败 ' + failed });
        await refresh();
      };

      return h('div', { className: 'dscm-root' }, [
        h('div', { key: 'head', className: 'dscm-head' }, [
          h('span', { key: 't', className: 'dscm-title' }, '自定义模型'),
          h('span', { key: 's', className: 'dscm-sub' },
            '中转站 / 自部署 / 任何兼容接口，写的是官方同一份配置。检验会现场问端点：哪些模型真的能用、真实上下文窗口与输出上限、端点接受的推理档位。'),
          h('div', { key: 'a', className: 'dscm-actions' }, [
            h('button', {
              key: 'builtin',
              type: 'button',
              className: 'dscm-btn dscm-btn-sm',
              title: '内置提供商也能检验；它们的模型清单来自适配器目录，写回会先要求你手工声明模型',
              onClick: () => setShowBuiltin((v) => !v),
            }, showBuiltin ? '只看自定义（' + customProviders.length + '）' : '显示内置（' + providers.length + '）'),
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'dscm-btn dscm-btn-sm',
              disabled: snapshot.loading,
              onClick: () => { setMark(null); refresh(); },
            }, snapshot.loading ? '读取中…' : '刷新'),
            h('button', {
              key: 'add',
              type: 'button',
              className: 'dscm-btn dscm-btn-sm dscm-btn-primary',
              onClick: () => { setMark(null); setEditing({ mode: 'new' }); },
            }, '＋ 新增自定义模型'),
            h('button', {
              key: 'enrichAll',
              type: 'button',
              className: 'dscm-btn dscm-btn-sm',
              title: '向每条提供商的端点要模型目录与推理档位，把上下文窗口 / 输出上限 / 推理等级写进配置',
              disabled: enriching !== null || listed.length === 0,
              onClick: autoFillAll,
            }, enriching !== null ? '补全中…' : '全部自动补全'),
            h('button', {
              key: 'probe',
              type: 'button',
              className: 'dscm-btn dscm-btn-sm',
              disabled: running || listed.length === 0,
              onClick: () => { setMark(null); probeAll(); },
            }, running ? '检验中…' : '全部快速检验'),
            h('button', {
              key: 'export',
              type: 'button',
              className: 'dscm-btn dscm-btn-sm',
              disabled: customProviders.length === 0,
              onClick: exportJson,
            }, '导出 JSON'),
            h('button', {
              key: 'import',
              type: 'button',
              className: 'dscm-btn dscm-btn-sm',
              onClick: () => setImporting((v) => !v),
            }, '导入 JSON'),
          ]),
        ]),
        h('div', { key: 'body', className: 'dscm-body' }, [
          snapshot.error !== null ? h('div', { key: 'err', className: 'dscm-err' }, snapshot.error) : null,
          data !== null && data.settingsAvailable === false
            ? h('div', { key: 'nosettings', className: 'dscm-warn' }, '设置服务不可用：当前 profile 没有挂载可编辑的设置层，面板只能读不能写。')
            : null,
          data !== null && data.writable === false
            ? h('div', { key: 'ro', className: 'dscm-warn' }, '这个 profile 的设置是只读的（由部署层固定），面板仅展示。')
            : null,
          mark !== null && mark.ok ? h('div', { key: 'mok', className: 'dscm-ok' }, mark.ok) : null,
          mark !== null && mark.error ? h('div', { key: 'merr', className: 'dscm-err' }, mark.error) : null,
          listed.length === 0
            ? h('div', { key: 'empty', className: 'dscm-empty' },
              customProviders.length === 0
                ? '还没有自定义模型提供商。点右上角「＋ 新增自定义模型」填写端点与密钥；也可以先用「获取可用模型」把端点公布的全部模型带进来。'
                : '没有可显示的提供商（当前只看自定义）。')
            : h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              listed.map((provider) => {
                const job = snapshot.probes[provider.id];
                const summary = job !== undefined && job.results && job.results.length > 0 ? summarize(job.results) : null;
                const editingThis = editing !== null && editing.mode === 'edit' && editing.provider.id === provider.id;
                return h('div', { key: provider.id }, [
                  h('div', { key: 'row', className: 'dscm-row' }, [
                    h('div', { key: 'main', className: 'dscm-row-main' }, [
                      h('span', { key: 'd', className: 'dscm-dot' + jobDot(job), title: job !== undefined && job.state ? '上次检验：' + job.state : '' }),
                      h('span', { key: 'id', className: 'dscm-id', title: provider.id }, provider.id),
                      h('span', { key: 'k', className: 'dscm-mini' }, provider.key && provider.key.configured
                        ? h('span', { className: 'dscm-tag dscm-tag-ok' }, '密钥已存')
                        : h('span', { className: 'dscm-tag dscm-tag-bad' }, '未配密钥')),
                      h('span', { key: 'n', className: 'dscm-mini', title: provider.modelsFrom === 'catalog' ? '模型清单来自适配器内置目录，检验时自动发现' : '模型清单写在你自己的配置里' },
                        provider.modelsFrom === 'catalog' ? '内置目录' : (provider.models || []).length + ' 个模型'),
                    ]),
                    h('span', { key: 'a', className: 'dscm-actions' }, [
                      summary !== null
                        ? h('span', { key: 'sum', className: 'dscm-mini' }, '可用 ' + summary.ok + '/' + (job.total || 0))
                        : null,
                      h('button', {
                        key: 'enrich',
                        type: 'button',
                        className: 'dscm-btn dscm-btn-sm',
                        title: '自动获取上下文窗口 / 输出上限 / 推理档位并写入配置',
                        disabled: enriching !== null,
                        onClick: () => autoFill(provider),
                      }, enriching === provider.id ? '补全中…' : '自动补全'),
                      h('button', {
                        key: 'probe',
                        type: 'button',
                        className: 'dscm-btn dscm-btn-sm',
                        disabled: job !== undefined && (job.state === 'running' || job.state === 'starting'),
                        onClick: () => {
                          setMark(null);
                          setOpenProbes((prev) => ({ ...prev, [provider.id]: true }));
                          startProbe(provider, 'alive');
                        },
                      }, '检验'),
                      h('button', {
                        key: 'detail',
                        type: 'button',
                        className: 'dscm-btn dscm-btn-sm',
                        title: '展开 / 收起该提供商的检验结果',
                        onClick: () => setOpenProbes((prev) => ({ ...prev, [provider.id]: !prev[provider.id] })),
                      }, openProbes[provider.id] ? '收起' : '详情'),
                      h('button', {
                        key: 'edit',
                        type: 'button',
                        className: 'dscm-btn dscm-btn-sm',
                        onClick: () => { setMark(null); setEditing(editingThis ? null : { mode: 'edit', provider }); },
                      }, editingThis ? '收起' : '编辑'),
                      h('button', {
                        key: 'del',
                        type: 'button',
                        className: 'dscm-btn dscm-btn-sm dscm-btn-danger',
                        disabled: busy,
                        onClick: () => remove(provider),
                      }, '删除'),
                    ]),
                    h('div', { key: 'url', className: 'dscm-row-url dscm-url', title: provider.baseURL }, provider.baseURL || '（未设置端点）'),
                  ]),
                  editingThis
                    ? h(Editor, {
                      key: 'editor',
                      initial: provider,
                      protocols,
                      revision: data ? data.revision : undefined,
                      onDone: () => { setEditing(null); setMark({ ok: '已保存 ' + provider.id }); },
                      onCancel: () => setEditing(null),
                    })
                    : null,
                  editingThis === false && openProbes[provider.id] === true
                    ? h('div', { key: 'probe', style: { marginTop: 8 } }, h(ProbeArea, { provider, revision: data ? data.revision : undefined, job, compact: true }))
                    : null,
                ]);
              })),
          editing !== null && editing.mode === 'new'
            ? h(Editor, {
              key: 'new',
              initial: null,
              protocols,
              revision: data ? data.revision : undefined,
              onDone: () => { setEditing(null); setMark({ ok: '已新增提供商' }); },
              onCancel: () => setEditing(null),
            })
            : null,
          importing
            ? h('div', { key: 'import', className: 'dscm-field dscm-field-wide' }, [
              h('span', { key: 'l', className: 'dscm-label' }, '粘贴导出的 JSON（只含端点与模型清单，不含密钥）'),
              h('textarea', {
                key: 't',
                className: 'dscm-input',
                style: { height: 120, padding: 8, resize: 'vertical', fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, Consolas, monospace)' },
                value: importText,
                onChange: (event) => setImportText(event.target.value),
              }),
              h('div', { key: 'a', className: 'dscm-actions' }, [
                h('button', { key: 'go', type: 'button', className: 'dscm-btn dscm-btn-sm dscm-btn-primary', disabled: busy || importText.trim().length === 0, onClick: importJson }, busy ? '导入中…' : '导入'),
                h('button', { key: 'x', type: 'button', className: 'dscm-btn dscm-btn-sm', onClick: () => { setImporting(false); setImportText(''); } }, '取消'),
              ]),
            ])
            : null,
          h('div', { key: 'foot', className: 'dscm-hint' },
            '提示：检验会在本机直接调用模型端点（不发往任何第三方），密钥只在 host 侧读取。写回只改「上下文 / 输出上限 / 推理档位」，不动端点与密钥。'),
        ]),
      ]);
    }

    // ── 注册 ─────────────────────────────────────────────────────────────────
    const apply = (ctx) => {
      installStyles();
      try {
        ctx.slots.inject('settings.models.footer', () => {
          try {
            ctx.slots.register({ name: 'settings.models.footer', id: 'custom-model', order: 50 }, FooterPanel);
          } catch (error) {
            console.warn('[custom-model] footer slot registration failed:', (error && error.message) || error);
          }
        });
      } catch (error) {
        console.warn('[custom-model] footer slot unavailable:', (error && error.message) || error);
      }
      try {
        ctx.slots.inject('settings.models.provider-card', () => {
          try {
            ctx.slots.register({ name: 'settings.models.provider-card', key: SETTINGS_NS }, ProviderCardPanel);
          } catch (error) {
            console.warn('[custom-model] provider-card slot registration failed:', (error && error.message) || error);
          }
        });
      } catch (error) {
        console.warn('[custom-model] provider-card slot unavailable:', (error && error.message) || error);
      }
    };

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
