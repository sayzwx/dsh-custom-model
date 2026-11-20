/**
 * 自定义模型 —— host 半身（Cordis 插件）。
 *
 * 两件事，都在 Node 侧完成：
 *
 * 1. **自定义模型（llm-pi-ai 手写路由）的增删改** —— 官方「设置 → 模型」页已经提供了
 *    逐条添加的表单，但它是「一次一条、卡片式」的：没有总览、没有批量导入导出、
 *    不能把一条路由的模型清单整体换掉。这里用 host 侧的 `ctx.settings`（SettingsForms）
 *    以路径操作（set/unset）写入同一个 `llm-pi-ai` 命名空间，所以官方页与这里的改动
 *    永远是同一份数据，不存在两套配置。密钥走 `ctx.credentials`，从不进入浏览器。
 *
 * 2. **模型检验（探测）** —— 配置里写死的「模型清单 / 上下文窗口 / 输出上限 / 推理档位」
 *    厂商随时会变。探测引擎（./probe-core.js）现场问端点：可用性、真实上下文窗口、
 *    真实输出上限、端点真正接受的推理档位，并可把答案写回上面那份配置。
 *    探测必须在 host 侧：模型端点没有 CORS 头，密钥也不该进渲染进程。
 *
 * 路线：
 *   GET  /dsh-custom-model/ping
 *   GET  /dsh-custom-model/state
 *   POST /dsh-custom-model/provider/save
 *   POST /dsh-custom-model/provider/remove
 *   POST /dsh-custom-model/models/discover
 *   POST /dsh-custom-model/probe/start
 *   GET  /dsh-custom-model/probe/status?id=
 *   POST /dsh-custom-model/probe/cancel
 *   POST /dsh-custom-model/probe/apply
 *
 * @module dsh-custom-model/host
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createProbeEngine, ENGINE_LEVELS } from './probe-core.js';

/** Route prefix owned by this plugin. */
const API_PREFIX = '/dsh-custom-model';
/** The only settings namespace a hand-declared provider can live in. */
const SETTINGS_NS = 'llm-pi-ai';
/** Provider route id: it becomes a settings key, a profile key, and a credential stem. */
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Wire protocols a hand-declared route may name. Kept in the adapter's own
 * order (most-reached first) so the first is the form's default; a protocol
 * the running adapter no longer accepts is refused at save time by the config
 * schema, which is the authority — this list only feeds the picker.
 */
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
/** Finished probe jobs kept in memory; older ones are pruned on each start. */
const MAX_JOBS = 8;
/** Progress lines kept per job. */
const MAX_LOG_LINES = 40;
/** Refuse request bodies larger than this (the model list is the bulk). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Write one JSON response. Never logs or echoes anything but the payload. */
function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Read and parse a JSON request body with a hard size cap. */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

/** An error carrying the HTTP status the route should answer with. */
class RouteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve one host service without declaring it as a hard dependency: a
 * profile without the settings page must still boot this plugin's routes and
 * answer "unavailable" instead of stopping the whole profile.
 * @param ctx - host plugin context.
 * @param name - service name.
 * @returns the service, or undefined.
 */
function svc(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name);
  } catch {
    /* a service that throws on get is indistinguishable from absent here */
  }
  return undefined;
}

/** Positive finite integer, or undefined. */
function num(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** The conventional credential reference for a route (`qwen` → `QWEN_API_KEY`). */
function deriveKeyRef(provider) {
  return `${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/**
 * Read one reference from the credentials-local YAML file. Fallback only: the
 * credentials service answers first when mounted.
 * @param text - the .credentials.yaml contents.
 * @param ref - the reference name to find.
 * @returns the value, or undefined.
 */
function readRefFromYaml(text, ref) {
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    if (/^\S/.test(line)) break;
    const match = /^\s{1,4}([A-Za-z0-9_]+):\s+(\S.*?)\s*$/.exec(line);
    if (match === null || match[1] !== ref) continue;
    let value = match[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Resolve a credential reference to its plaintext. Order: the official
 * credentials service → the credentials-local file under the DSH home.
 * The value never enters a job record, a status payload, or a log line.
 * @param ctx - host plugin context.
 * @param ref - the reference name from the provider profile.
 * @returns the value, or undefined.
 */
async function resolveApiKey(ctx, ref) {
  if (typeof ref !== 'string' || ref.length === 0) return undefined;
  const credentials = svc(ctx, 'credentials');
  try {
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value;
    }
  } catch (error) {
    console.warn(`[custom-model] credentials lookup failed for ${ref}:`, (error && error.message) || error);
  }
  try {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh');
    const text = await readFile(join(home, '.credentials.yaml'), 'utf8');
    return readRefFromYaml(text, ref);
  } catch {
    return undefined;
  }
}

/** Normalize one stored model entry for the wire. */
function modelView(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  const id = typeof entry.id === 'string' ? entry.id : undefined;
  if (id === undefined || id.length === 0) return undefined;
  const view = { id };
  if (typeof entry.name === 'string' && entry.name.length > 0) view.name = entry.name;
  const context = num(entry.contextWindow);
  if (context !== undefined) view.contextWindow = context;
  const maxTokens = num(entry.maxTokens);
  if (maxTokens !== undefined) view.maxTokens = maxTokens;
  if (Array.isArray(entry.input) && entry.input.length > 0) view.input = entry.input.filter((m) => typeof m === 'string');
  if (entry.reasoningEfforts === false) view.reasoningEfforts = false;
  else if (entry.reasoningEfforts !== null && typeof entry.reasoningEfforts === 'object') {
    view.reasoningEfforts = Object.fromEntries(
      Object.entries(entry.reasoningEfforts).filter(([, v]) => typeof v === 'string'),
    );
  }
  return view;
}

/**
 * Read the adapter's own model catalog for one route. Used for shipped
 * providers whose profile carries no explicit `models` list: without it the
 * probe panel would have nothing to interrogate on those routes.
 * @param llm - the llm service, when mounted.
 * @param provider - route id.
 * @returns model views (id + name), or an empty list.
 */
async function catalogModels(llm, provider) {
  if (llm === undefined || typeof llm.listModels !== 'function') return [];
  try {
    const list = await llm.listModels(provider);
    if (!Array.isArray(list)) return [];
    return list
      .map((model) => {
        if (model === null || typeof model !== 'object') return undefined;
        const id = typeof model.id === 'string' ? model.id : undefined;
        if (id === undefined || id.length === 0) return undefined;
        return typeof model.name === 'string' && model.name.length > 0 ? { id, name: model.name } : { id };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read the whole custom-provider picture: the joined provider directory, the
 * composite profile of every route, its user layer (so the UI knows whether a
 * removal restores a base layer), and the credential state of its key.
 * @param ctx - host plugin context.
 * @returns the wire snapshot the panel renders.
 */
async function readState(ctx) {
  const settings = svc(ctx, 'settings');
  const llm = svc(ctx, 'llm');
  const credentials = svc(ctx, 'credentials');

  let descriptor;
  let settingsAvailable = false;
  let writable = false;
  if (settings !== undefined && typeof settings.describe === 'function') {
    settingsAvailable = true;
    try {
      const all = settings.describe({ redactSecrets: true });
      descriptor = Array.isArray(all) ? all.find((row) => row !== null && typeof row === 'object' && row.ns === SETTINGS_NS) : undefined;
      writable = settings.writable !== false;
    } catch (error) {
      console.warn('[custom-model] settings.describe failed:', (error && error.message) || error);
    }
  }

  const composite = (descriptor !== undefined && descriptor.value !== null && typeof descriptor.value === 'object'
    && descriptor.value.providers !== null && typeof descriptor.value.providers === 'object')
    ? descriptor.value.providers
    : {};
  const userLayer = (descriptor !== undefined && descriptor.user !== null && typeof descriptor.user === 'object'
    && descriptor.user.providers !== null && typeof descriptor.user.providers === 'object')
    ? descriptor.user.providers
    : {};

  const directory = llm !== undefined && typeof llm.listConfigurableProviders === 'function'
    ? llm.listConfigurableProviders()
    : [];
  const registered = llm !== undefined && typeof llm.listProviders === 'function' ? llm.listProviders() : [];
  const activeIds = new Set(Array.isArray(registered) ? registered.map((row) => row && row.id) : []);

  const rows = [];
  for (const entry of Array.isArray(directory) ? directory : []) {
    if (entry === null || typeof entry !== 'object' || entry.settingsNs !== SETTINGS_NS) continue;
    const id = String(entry.provider);
    const profile = composite[id] !== null && typeof composite[id] === 'object' ? composite[id] : {};
    const userProfile = userLayer[id] !== null && typeof userLayer[id] === 'object' ? userLayer[id] : {};
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0
      ? profile.apiKeyEnv
      : deriveKeyRef(id);
    let key = { ref: apiKeyEnv, configured: false, writable: false };
    if (credentials !== undefined && typeof credentials.describe === 'function') {
      try {
        const info = await credentials.describe(apiKeyEnv);
        key = {
          ref: apiKeyEnv,
          configured: !!(info !== undefined && info.configured),
          writable: !!(info !== undefined && info.writable),
          ...(info !== undefined && typeof info.masked === 'string' ? { masked: info.masked } : {}),
        };
      } catch {
        /* an unreadable credential is reported as unconfigured, never as an error page */
      }
    }
    // 写死在配置里的模型清单；内置路由的清单不在配置里，等到检验时再向
    // 适配器目录要（见 probe/start），否则每次读状态都要问 41 条路由。
    const configured = Array.isArray(profile.models) ? profile.models.map(modelView).filter(Boolean) : undefined;
    const models = configured === undefined ? [] : configured;
    const modelsFrom = configured === undefined ? 'catalog' : 'config';
    rows.push({
      id,
      displayName: typeof profile.displayName === 'string' && profile.displayName.length > 0
        ? profile.displayName
        : (typeof entry.displayName === 'string' && entry.displayName.length > 0 ? entry.displayName : id),
      api: typeof profile.api === 'string' ? profile.api : '',
      baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : (typeof entry.defaultBaseURL === 'string' ? entry.defaultBaseURL : ''),
      declared: entry.declared === true,
      /** 用户自己声明或改过的那一条 —— 总览默认只列这些。 */
      custom: entry.declared === true || Object.keys(userProfile).length > 0,
      active: activeIds.has(id),
      models,
      modelsFrom,
      /** Whether the user layer itself carries the model list (only then can a write-back address indexes). */
      modelsInUserLayer: Array.isArray(userProfile.models),
      hasCatalog: !Array.isArray(profile.models),
      hasUserProfile: Object.keys(userProfile).length > 0,
      key,
    });
  }

  return {
    settingsAvailable,
    writable,
    revision: descriptor !== undefined && typeof descriptor.revision === 'number' ? descriptor.revision : undefined,
    composite,
    userLayer,
    providers: rows,
  };
}

/** Build the ops that store one provider profile. */
function providerOps(ctx, body, current) {
  const id = String(body.id).trim();
  const originalId = typeof body.originalId === 'string' && body.originalId.trim().length > 0
    ? body.originalId.trim()
    : id;
  const ops = [];
  if (originalId !== id) ops.push({ op: 'unset', path: ['providers', originalId] });

  const base = ['providers', id];
  const apiKeyEnv = typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.trim().length > 0
    ? body.apiKeyEnv.trim()
    : deriveKeyRef(id);
  const api = typeof body.api === 'string' ? body.api.trim() : '';
  const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';

  ops.push({ op: 'set', path: [...base, 'apiKeyEnv'], value: apiKeyEnv });
  ops.push({ op: 'set', path: [...base, 'api'], value: api });
  ops.push({ op: 'set', path: [...base, 'baseURL'], value: baseURL });
  if (displayName.length > 0) ops.push({ op: 'set', path: [...base, 'displayName'], value: displayName });
  else ops.push({ op: 'unset', path: [...base, 'displayName'] });

  if (Array.isArray(body.models)) {
    const models = body.models.map((raw) => {
      const entry = { id: String(raw.id).trim() };
      if (typeof raw.name === 'string' && raw.name.trim().length > 0) entry.name = raw.name.trim();
      const context = num(raw.contextWindow);
      if (context !== undefined) entry.contextWindow = context;
      const maxTokens = num(raw.maxTokens);
      if (maxTokens !== undefined) entry.maxTokens = maxTokens;
      if (Array.isArray(raw.input) && raw.input.length > 0) entry.input = raw.input.filter((m) => typeof m === 'string');
      if (raw.reasoningEfforts === false) entry.reasoningEfforts = false;
      else if (raw.reasoningEfforts !== null && typeof raw.reasoningEfforts === 'object') {
        const efforts = Object.fromEntries(
          Object.entries(raw.reasoningEfforts).filter(([, v]) => typeof v === 'string' && v.length > 0),
        );
        if (Object.keys(efforts).length > 0) entry.reasoningEfforts = efforts;
      }
      return entry;
    });
    ops.push({ op: 'set', path: [...base, 'models'], value: models });
  }
  return { id, originalId, apiKeyEnv, ops };
}

/** Validate one save body before anything is written. */
function validateSave(body) {
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!PROVIDER_ID_RE.test(id)) {
    throw new RouteError(400, 'Provider ID 只能包含字母、数字、点、下划线和连字符，且不能以符号开头（它同时是配置键与凭据前缀）');
  }
  if (typeof body.baseURL !== 'string' || body.baseURL.trim().length === 0) {
    throw new RouteError(400, '端点地址（baseURL）必填');
  }
  let url;
  try {
    url = new URL(body.baseURL.trim());
  } catch {
    throw new RouteError(400, '端点地址必须是合法的 HTTP/HTTPS URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RouteError(400, '端点地址只支持 http / https');
  }
  const models = Array.isArray(body.models) ? body.models : [];
  if (models.length === 0) {
    throw new RouteError(400, '至少需要一个模型：模型 id 是唯一识别它的东西');
  }
  const seen = new Set();
  for (const model of models) {
    const modelId = model !== null && typeof model === 'object' && typeof model.id === 'string' ? model.id.trim() : '';
    if (modelId.length === 0) throw new RouteError(400, '模型清单里有空 id');
    if (seen.has(modelId)) throw new RouteError(400, `模型 id 重复：${modelId}`);
    seen.add(modelId);
  }
}

/**
 * Host half of 自定义模型.
 */
export default {
  inject: ['webServer'],
  apply(ctx) {
    const engine = createProbeEngine({});
    /** jobId → job. Jobs live in memory only; results are UI state, not facts. */
    const jobs = new Map();
    /** provider id → its running job (one at a time per provider). */
    const activeByProvider = new Map();
    let jobSeq = 0;

    /** Drop the oldest finished jobs so the map cannot grow without bound. */
    function pruneJobs() {
      while (jobs.size > MAX_JOBS) {
        let removed = false;
        for (const [id, job] of jobs) {
          if (job.state === 'running') continue;
          jobs.delete(id);
          removed = true;
          break;
        }
        if (!removed) return;
      }
    }

    /** The status payload shared by the poll endpoint. */
    function statusPayload(job) {
      return {
        ok: true,
        jobId: job.id,
        state: job.state,
        mode: job.mode,
        provider: job.provider,
        total: job.total,
        finished: job.results.length > 0 ? job.results.length : job.resultMap.size,
        catalog: job.catalog,
        results: job.results.length > 0 ? job.results : [...job.resultMap.values()],
        log: job.log.slice(-MAX_LOG_LINES),
        error: job.error,
      };
    }

    const routes = [
      {
        path: `${API_PREFIX}/ping`,
        handler: (req, res) => {
          sendJson(res, 200, { ok: true, version: '1.0.0', settingsNs: SETTINGS_NS, protocols: PROTOCOLS, levels: ENGINE_LEVELS });
        },
      },
      {
        path: `${API_PREFIX}/state`,
        handler: async (req, res) => {
          const state = await readState(ctx);
          sendJson(res, 200, {
            ok: true,
            settingsNs: SETTINGS_NS,
            settingsAvailable: state.settingsAvailable,
            writable: state.writable,
            revision: state.revision,
            protocols: PROTOCOLS,
            levels: ENGINE_LEVELS,
            providers: state.providers,
          });
        },
      },
      {
        path: `${API_PREFIX}/provider/save`,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' });
            return;
          }
          const body = await readJsonBody(req);
          validateSave(body);
          const settings = svc(ctx, 'settings');
          if (settings === undefined || typeof settings.mutate !== 'function') {
            sendJson(res, 503, { ok: false, error: '设置服务不可用（settings 未挂载）' });
            return;
          }
          const credentials = svc(ctx, 'credentials');
          const { id, apiKeyEnv, ops } = providerOps(ctx, body, null);
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
          if (apiKey.length > 0) {
            if (credentials === undefined || typeof credentials.set !== 'function') {
              sendJson(res, 503, { ok: false, error: '凭据服务不可用（credentials 未挂载），无法保存密钥' });
              return;
            }
            try {
              await credentials.set(apiKeyEnv, apiKey);
            } catch (error) {
              sendJson(res, 400, { ok: false, error: `密钥保存失败：${(error && error.message) || error}` });
              return;
            }
          }
          try {
            await settings.mutate(SETTINGS_NS, ops, typeof body.revision === 'number' ? body.revision : undefined);
          } catch (error) {
            const message = (error && error.message) || String(error);
            const conflict = error !== null && typeof error === 'object' && (error.code === 'SETTINGS_CONFLICT' || error.name === 'SettingsConflictError');
            sendJson(res, conflict ? 409 : 400, { ok: false, conflict, error: message });
            return;
          }
          const state = await readState(ctx);
          sendJson(res, 200, { ok: true, id, revision: state.revision, providers: state.providers });
        },
      },
      {
        path: `${API_PREFIX}/provider/remove`,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' });
            return;
          }
          const body = await readJsonBody(req, 64 * 1024);
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          if (id.length === 0) {
            sendJson(res, 400, { ok: false, error: 'id is required' });
            return;
          }
          const settings = svc(ctx, 'settings');
          if (settings === undefined || typeof settings.mutate !== 'function') {
            sendJson(res, 503, { ok: false, error: '设置服务不可用（settings 未挂载）' });
            return;
          }
          const before = await readState(ctx);
          const profile = before.composite[id] !== null && typeof before.composite[id] === 'object' ? before.composite[id] : {};
          try {
            await settings.mutate(SETTINGS_NS, [{ op: 'unset', path: ['providers', id] }], typeof body.revision === 'number' ? body.revision : undefined);
          } catch (error) {
            const message = (error && error.message) || String(error);
            const conflict = error !== null && typeof error === 'object' && (error.code === 'SETTINGS_CONFLICT' || error.name === 'SettingsConflictError');
            sendJson(res, conflict ? 409 : 400, { ok: false, conflict, error: message });
            return;
          }
          // Only the route's own derived reference is provably owned by this row.
          const credentials = svc(ctx, 'credentials');
          const ref = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined;
          if (body.keepKey !== true && ref !== undefined && ref === deriveKeyRef(id)
            && credentials !== undefined && typeof credentials.unset === 'function') {
            try {
              await credentials.unset(ref);
            } catch (error) {
              console.warn(`[custom-model] could not remove credential ${ref}:`, (error && error.message) || error);
            }
          }
          const state = await readState(ctx);
          sendJson(res, 200, { ok: true, revision: state.revision, providers: state.providers });
        },
      },
      {
        path: `${API_PREFIX}/models/discover`,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' });
            return;
          }
          const body = await readJsonBody(req, 64 * 1024);
          const llm = svc(ctx, 'llm');
          if (llm === undefined || typeof llm.discoverModels !== 'function') {
            sendJson(res, 503, { ok: false, error: '模型服务不可用（llm 未挂载）' });
            return;
          }
          const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim().length > 0
            ? body.apiKey.trim()
            : await resolveApiKey(ctx, typeof body.apiKeyEnv === 'string' ? body.apiKeyEnv : undefined);
          try {
            const models = await llm.discoverModels(SETTINGS_NS, {
              ...(typeof body.provider === 'string' && body.provider.length > 0 ? { provider: body.provider } : {}),
              ...(typeof body.baseURL === 'string' && body.baseURL.length > 0 ? { baseURL: body.baseURL } : {}),
              ...(typeof body.api === 'string' && body.api.length > 0 ? { api: body.api } : {}),
              ...(apiKey !== undefined ? { apiKey } : {}),
            });
            sendJson(res, 200, { ok: true, models: Array.isArray(models) ? models : [] });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: (error && error.message) || String(error) });
          }
        },
      },
      {
        path: `${API_PREFIX}/provider/enrich`,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' });
            return;
          }
          const body = await readJsonBody(req, 64 * 1024);
          const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
          if (provider.length === 0) {
            sendJson(res, 400, { ok: false, error: 'provider is required' });
            return;
          }
          const settings = svc(ctx, 'settings');
          const llm = svc(ctx, 'llm');
          const before = await readState(ctx);
          const entry = before.providers.find((row) => row.id === provider);
          if (entry === undefined) {
            sendJson(res, 404, { ok: false, error: `未知提供商：${provider}` });
            return;
          }
          if (entry.baseURL.length === 0) {
            sendJson(res, 400, { ok: false, error: '该提供商没有端点地址，无法自动补全' });
            return;
          }
          const apiKey = await resolveApiKey(ctx, entry.key ? entry.key.ref : undefined);
          if (apiKey === undefined) {
            sendJson(res, 400, {
              ok: false,
              error: entry.key && entry.key.ref
                ? `取不到密钥 ${entry.key.ref}：先在官方「设置 → 模型」里保存它`
                : '该提供商没有命名凭据引用，自动补全需要一次可用的密钥',
            });
            return;
          }

          // 1) 模型清单：配置里有就用配置的；没有就向端点/适配器要一份。
          const profile = before.composite[provider] !== null && typeof before.composite[provider] === 'object' ? before.composite[provider] : {};
          const userProfile = before.userLayer[provider] !== null && typeof before.userLayer[provider] === 'object' ? before.userLayer[provider] : {};
          const userModels = Array.isArray(userProfile.models) ? userProfile.models : undefined;
          const configured = Array.isArray(profile.models) ? profile.models : [];
          let models = configured;
          let discovered = false;
          if (models.length === 0) {
            const found = llm !== undefined && typeof llm.discoverModels === 'function'
              ? await llm.discoverModels(SETTINGS_NS, { provider }).catch(() => [])
              : [];
            models = (Array.isArray(found) ? found : []).map((model) => ({
              id: model.id,
              ...(model.name === undefined ? {} : { name: model.name }),
            }));
            discovered = models.length > 0;
          }
          if (models.length === 0) {
            sendJson(res, 400, { ok: false, error: '端点与适配器都没有给出模型清单，无法自动补全' });
            return;
          }

          // 2) 自动补全：目录 + 端点档位枚举（1~2 次请求；没有目录时引擎自己降级成逐个探测）。
          const out = await engine.runProbe({
            baseURL: entry.baseURL,
            api: entry.api || undefined,
            apiKey,
            models: models.map((model) => model.id).filter((id) => typeof id === 'string' && id.length > 0),
            mode: 'enrich',
          });

          // 3) 写成配置：只写实测到的字段，其余原样保留。
          const base = ['providers', provider];
          const ops = [];
          let written = 0;
          const effortCount = out.results.reduce((n, row) => (
            row.efforts !== null && typeof row.efforts === 'object' && Object.keys(row.efforts).length > 0 ? n + 1 : n
          ), 0);

          if (userModels !== undefined) {
            for (const row of out.results) {
              const index = models.findIndex((model) => model !== null && typeof model === 'object' && model.id === row.id);
              if (index < 0) continue;
              const context = num(row.contextWindow);
              if (context !== undefined) {
                ops.push({ op: 'set', path: [...base, 'models', String(index), 'contextWindow'], value: context });
                written += 1;
              }
              const maxTokens = num(row.maxTokens);
              if (maxTokens !== undefined) {
                ops.push({ op: 'set', path: [...base, 'models', String(index), 'maxTokens'], value: maxTokens });
                written += 1;
              }
              if (row.efforts === false) {
                ops.push({ op: 'set', path: [...base, 'models', String(index), 'reasoningEfforts'], value: false });
                written += 1;
              } else if (row.efforts !== null && typeof row.efforts === 'object' && Object.keys(row.efforts).length > 0) {
                const cleaned = Object.fromEntries(Object.entries(row.efforts).filter(([, v]) => typeof v === 'string' && v.length > 0));
                if (Object.keys(cleaned).length > 0) {
                  ops.push({ op: 'set', path: [...base, 'models', String(index), 'reasoningEfforts'], value: cleaned });
                  written += 1;
                }
              }
            }
          } else if (entry.declared === true) {
            // 声明过但没有模型清单：把清单连同能力值一起写进去 —— 这就是「添加到配置中」。
            const nextModels = out.results.map((row) => {
              const model = { id: row.id };
              const context = num(row.contextWindow);
              if (context !== undefined) model.contextWindow = context;
              const maxTokens = num(row.maxTokens);
              if (maxTokens !== undefined) model.maxTokens = maxTokens;
              if (row.efforts === false) model.reasoningEfforts = false;
              else if (row.efforts !== null && typeof row.efforts === 'object' && Object.keys(row.efforts).length > 0) {
                const cleaned = Object.fromEntries(Object.entries(row.efforts).filter(([, v]) => typeof v === 'string' && v.length > 0));
                if (Object.keys(cleaned).length > 0) model.reasoningEfforts = cleaned;
              }
              return model;
            });
            ops.push({ op: 'set', path: [...base, 'models'], value: nextModels });
            written = nextModels.length;
          } else {
            sendJson(res, 200, {
              ok: true,
              written: 0,
              skipped: 'catalog-route',
              catalogLoaded: out.catalogLoaded,
              message: '这条内置提供商的模型清单来自适配器目录，能力值已经由目录提供；要写进你自己的配置，请先在卡片里手工声明模型清单',
            });
            return;
          }

          if (ops.length === 0) {
            sendJson(res, 200, {
              ok: true,
              written: 0,
              catalogLoaded: out.catalogLoaded,
              message: out.catalogLoaded
                ? '目录里没有这些模型的能力值，未写入'
                : '端点没有可读的目录，也没有给出版位枚举，未写入（不做猜测）',
            });
            return;
          }
          try {
            await settings.mutate(SETTINGS_NS, ops, typeof body.revision === 'number' ? body.revision : undefined);
          } catch (error) {
            const message = (error && error.message) || String(error);
            const conflict = error !== null && typeof error === 'object' && (error.code === 'SETTINGS_CONFLICT' || error.name === 'SettingsConflictError');
            sendJson(res, conflict ? 409 : 400, { ok: false, conflict, error: message });
            return;
          }
          const after = await readState(ctx);
          sendJson(res, 200, {
            ok: true,
            written,
            effortCount,
            discovered,
            catalogLoaded: out.catalogLoaded,
            catalogSize: out.catalogSize,
            revision: after.revision,
            providers: after.providers,
            message: `已写入 ${written} 项能力值${effortCount > 0 ? `，其中 ${effortCount} 个模型带推理档位` : ''}`,
          });
        },
      },
      {
        path: `${API_PREFIX}/probe/start`,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' });
            return;
          }
          const body = await readJsonBody(req);
          const provider = typeof body.provider === 'string' && body.provider.length > 0 ? body.provider : 'unknown';
          const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim().replace(/\/+$/, '') : '';
          const api = typeof body.api === 'string' && body.api.length > 0 ? body.api : undefined;
          const mode = body.mode === 'full' ? 'full' : 'alive';
          const models = Array.isArray(body.models)
            ? body.models.filter((m) => typeof m === 'string' && m.length > 0).slice(0, 4000)
            : [];
          if (models.length === 0 && provider !== 'unknown') {
            // 内置提供商的清单不在用户配置里：先问适配器要，再开始检验。
            const llm = svc(ctx, 'llm');
            if (llm !== undefined) {
              try {
                const found = typeof llm.discoverModels === 'function'
                  ? await llm.discoverModels(SETTINGS_NS, { provider })
                  : await catalogModels(llm, provider);
                for (const model of Array.isArray(found) ? found : []) {
                  const modelId = model !== null && typeof model === 'object' ? model.id : undefined;
                  if (typeof modelId === 'string' && modelId.length > 0) models.push(modelId);
                }
              } catch (error) {
                console.warn(`[custom-model] could not enumerate ${provider}:`, (error && error.message) || error);
              }
            }
          }
          if (baseURL.length === 0) {
            sendJson(res, 400, { ok: false, error: 'baseURL is required' });
            return;
          }
          if (models.length === 0) {
            sendJson(res, 400, { ok: false, error: '没有可检验的模型' });
            return;
          }
          const inlineKey = typeof body.apiKey === 'string' && body.apiKey.length > 0 ? body.apiKey : undefined;
          const keyRef = typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.length > 0 ? body.apiKeyEnv : undefined;
          let apiKey = inlineKey;
          if (apiKey === undefined && keyRef !== undefined) apiKey = await resolveApiKey(ctx, keyRef);
          if (apiKey === undefined) {
            sendJson(res, 400, {
              ok: false,
              error: keyRef === undefined
                ? '没有可用的 API 密钥：该提供商没有命名凭据引用，也没有临时提供'
                : `没有可用的 API 密钥：引用 ${keyRef} 取不到值（先在「设置 → 模型」里保存它）`,
            });
            return;
          }

          const previous = activeByProvider.get(provider);
          if (previous !== undefined && previous.state === 'running') {
            try {
              previous.abort.abort();
            } catch {
              /* ignore */
            }
          }

          jobSeq += 1;
          const id = `p-${jobSeq}`;
          const abort = new AbortController();
          const job = {
            id,
            provider,
            mode,
            state: 'running',
            startedAt: Date.now(),
            total: models.length,
            results: [],
            resultMap: new Map(),
            catalog: { loaded: false, count: 0 },
            log: [],
            error: undefined,
            abort,
          };
          jobs.set(id, job);
          activeByProvider.set(provider, job);
          pruneJobs();

          (async () => {
            try {
              const out = await engine.runProbe({
                baseURL,
                api,
                apiKey,
                models,
                mode,
                onProgress: (line, row) => {
                  job.log.push(line);
                  if (job.log.length > MAX_LOG_LINES * 2) job.log.splice(0, job.log.length - MAX_LOG_LINES * 2);
                  if (row !== undefined) job.resultMap.set(row.id, row);
                },
                signal: abort.signal,
              });
              job.results = out.results;
              job.catalog = { loaded: out.catalogLoaded, count: out.catalogSize };
              job.state = 'done';
            } catch (error) {
              if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
                job.state = 'cancelled';
              } else {
                job.state = 'error';
                job.error = String((error && error.message) || error);
              }
            } finally {
              if (activeByProvider.get(provider) === job) activeByProvider.delete(provider);
            }
          })();

          sendJson(res, 200, { ok: true, jobId: id, mode, total: models.length });
        },
      },
      {
        path: `${API_PREFIX}/probe/status`,
        handler: (req, res) => {
          let id;
          try {
            id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? '';
          } catch {
            id = '';
          }
          const job = jobs.get(id);
          if (job === undefined) {
            sendJson(res, 404, { ok: false, error: `unknown probe job: ${id}` });
            return;
          }
          sendJson(res, 200, statusPayload(job));
        },
      },
      {
        path: `${API_PREFIX}/probe/cancel`,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' });
            return;
          }
          const body = await readJsonBody(req, 64 * 1024);
          const job = jobs.get(typeof body.id === 'string' ? body.id : '');
          if (job !== undefined && job.state === 'running') {
            try {
              job.abort.abort();
            } catch {
              /* ignore */
            }
          }
          sendJson(res, 200, { ok: true });
        },
      },
      {
        path: `${API_PREFIX}/probe/apply`,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' });
            return;
          }
          const body = await readJsonBody(req);
          const id = typeof body.provider === 'string' ? body.provider.trim() : '';
          const rows = Array.isArray(body.rows) ? body.rows : [];
          if (id.length === 0 || rows.length === 0) {
            sendJson(res, 400, { ok: false, error: 'provider 与 rows 均为必填' });
            return;
          }
          const settings = svc(ctx, 'settings');
          if (settings === undefined || typeof settings.mutate !== 'function') {
            sendJson(res, 503, { ok: false, error: '设置服务不可用（settings 未挂载）' });
            return;
          }
          const before = await readState(ctx);
          const profile = before.composite[id] !== null && typeof before.composite[id] === 'object' ? before.composite[id] : {};
          const userProfile = before.userLayer[id] !== null && typeof before.userLayer[id] === 'object' ? before.userLayer[id] : {};
          const models = Array.isArray(profile.models) ? profile.models : [];
          if (models.length === 0) {
            sendJson(res, 400, { ok: false, error: '该提供商没有写死的模型清单（走内置目录），无需写回' });
            return;
          }
          const userModels = Array.isArray(userProfile.models) ? userProfile.models : undefined;
          const base = ['providers', id, 'models'];
          const ops = [];
          let written = 0;
          if (userModels !== undefined) {
            for (const row of rows) {
              const modelId = row !== null && typeof row === 'object' ? row.id : undefined;
              const index = models.findIndex((m) => m !== null && typeof m === 'object' && m.id === modelId);
              if (index < 0) continue;
              const context = num(row.contextWindow);
              if (context !== undefined) {
                ops.push({ op: 'set', path: [...base, String(index), 'contextWindow'], value: context });
                written += 1;
              }
              const maxTokens = num(row.maxTokens);
              if (maxTokens !== undefined) {
                ops.push({ op: 'set', path: [...base, String(index), 'maxTokens'], value: maxTokens });
                written += 1;
              }
              const efforts = row.reasoningEfforts;
              if (efforts !== null && typeof efforts === 'object' && Object.keys(efforts).length > 0) {
                const cleaned = Object.fromEntries(Object.entries(efforts).filter(([, v]) => typeof v === 'string' && v.length > 0));
                if (Object.keys(cleaned).length > 0) {
                  ops.push({ op: 'set', path: [...base, String(index), 'reasoningEfforts'], value: cleaned });
                  written += 1;
                }
              }
            }
          } else {
            // The model list comes from a base layer; replace it wholesale only
            // for a route this user declared, never for a shipped catalog route.
            const entry = before.providers.find((row) => row.id === id);
            if (entry === undefined || entry.declared !== true) {
              sendJson(res, 400, {
                ok: false,
                error: '该路由的模型清单来自内置目录，自动写回会把它整份复制进用户配置；请先在该路由上手工声明模型清单',
              });
              return;
            }
            const nextModels = models.map((model) => {
              const row = rows.find((r) => r !== null && typeof r === 'object' && r.id === model.id);
              if (row === undefined) return model;
              const copy = { ...model };
              const context = num(row.contextWindow);
              if (context !== undefined) copy.contextWindow = context;
              const maxTokens = num(row.maxTokens);
              if (maxTokens !== undefined) copy.maxTokens = maxTokens;
              const efforts = row.reasoningEfforts;
              if (efforts !== null && typeof efforts === 'object' && Object.keys(efforts).length > 0) {
                copy.reasoningEfforts = Object.fromEntries(Object.entries(efforts).filter(([, v]) => typeof v === 'string' && v.length > 0));
              }
              return copy;
            });
            ops.push({ op: 'set', path: base, value: nextModels });
            written = nextModels.length;
          }
          if (ops.length === 0) {
            sendJson(res, 200, { ok: true, written: 0, message: '探测结果里没有可写回的字段' });
            return;
          }
          try {
            await settings.mutate(SETTINGS_NS, ops, typeof body.revision === 'number' ? body.revision : undefined);
          } catch (error) {
            const message = (error && error.message) || String(error);
            const conflict = error !== null && typeof error === 'object' && (error.code === 'SETTINGS_CONFLICT' || error.name === 'SettingsConflictError');
            sendJson(res, conflict ? 409 : 400, { ok: false, conflict, error: message });
            return;
          }
          const state = await readState(ctx);
          sendJson(res, 200, { ok: true, written, revision: state.revision, providers: state.providers });
        },
      },
    ];

    let registered = 0;
    for (const route of routes) {
      let dispose;
      try {
        dispose = ctx.webServer.register({
          kind: 'exact',
          path: route.path,
          handler: async (req, res) => {
            try {
              await route.handler(req, res);
            } catch (error) {
              const status = error instanceof RouteError ? error.status : 500;
              console.warn(`[custom-model] ${route.path} failed:`, (error && error.stack) || error);
              if (!res.headersSent) sendJson(res, status, { ok: false, error: (error && error.message) || String(error) });
              else res.end();
            }
          },
        });
        registered += 1;
      } catch (error) {
        console.warn(`[custom-model] route ${route.path} already served elsewhere, skipping:`, (error && error.message) || error);
        continue;
      }
      ctx.effect(() => dispose);
    }
    console.log(`[custom-model] host half active (${registered}/${routes.length} routes registered)`);
  },
};
