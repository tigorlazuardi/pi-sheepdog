import * as path from "node:path";

export type AdapterId = "generic" | "anthropic" | "openai-compatible";
export type AdapterArgs = Record<string, string>;

export interface MapperRule {
  regex: RegExp;
  adapter: AdapterId;
  scope: string;
  args: AdapterArgs;
}

export interface LoadedMapperConfig {
  rules: MapperRule[];
  warnings: string[];
}

const ADAPTER_IDS = new Set<AdapterId>(["generic", "anthropic", "openai-compatible"]);
const ANTHROPIC_ARG_NAMES = new Set(["credentialFile", "configDir", "baseUrl"]);
const PATH_ARG_NAMES = new Set(["credentialFile", "configDir"]);

function expandPathValue(value: string, home: string): string {
  if (value === "$HOME" || value === "~") return home;
  if (value.startsWith("$HOME/")) return path.join(home, value.slice(6));
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function validateAdapterArgs(adapter: AdapterId, rawArgs: unknown, ruleLabel: string, home: string): { args: AdapterArgs; warning?: string } {
  if (rawArgs === undefined) return { args: {} };
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { args: {}, warning: `${ruleLabel}: args must be an object` };
  }

  const args: AdapterArgs = {};
  for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
    if (adapter !== "anthropic" || !ANTHROPIC_ARG_NAMES.has(key)) {
      return { args: {}, warning: `${ruleLabel}: unknown args.${key} for adapter ${adapter}` };
    }
    if (typeof value !== "string" || value.length === 0) {
      return { args: {}, warning: `${ruleLabel}: args.${key} must be a non-empty string` };
    }
    args[key] = PATH_ARG_NAMES.has(key) ? expandPathValue(value, home) : value;
  }
  return { args };
}

export function loadMapperConfig(parsed: unknown, home: string): LoadedMapperConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rules: [], warnings: ["config root must be an object"] };
  }
  const mappers = (parsed as Record<string, unknown>).mappers;
  if (!Array.isArray(mappers)) {
    return { rules: [], warnings: ["config.mappers must be an array"] };
  }

  const rules: MapperRule[] = [];
  const warnings: string[] = [];
  mappers.forEach((raw, index) => {
    const label = `mappers[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`${label}: rule must be an object`);
      return;
    }
    const rule = raw as Record<string, unknown>;
    if (typeof rule.match !== "string" || typeof rule.scope !== "string" || typeof rule.adapter !== "string") {
      warnings.push(`${label}: match, adapter, and scope must be strings`);
      return;
    }
    if (!ADAPTER_IDS.has(rule.adapter as AdapterId)) {
      warnings.push(`${label}: unknown adapter`);
      return;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(rule.match);
    } catch {
      warnings.push(`${label}: invalid match regex`);
      return;
    }
    const adapter = rule.adapter as AdapterId;
    const { args, warning } = validateAdapterArgs(adapter, rule.args, label, home);
    if (warning) {
      warnings.push(warning);
      return;
    }
    rules.push({ regex, adapter, scope: rule.scope, args });
  });
  return { rules, warnings };
}

export function computeScopeGlob(modelRef: string | undefined): string | undefined {
  if (!modelRef) return undefined;
  const lastSlash = modelRef.lastIndexOf("/");
  return lastSlash === -1 ? undefined : `${modelRef.slice(0, lastSlash)}/*`;
}

export function resolveMapper(modelRef: string | undefined, config: LoadedMapperConfig, catchallScope = "*"): { adapter: AdapterId; scopeGlob: string; args: AdapterArgs } {
  if (modelRef) {
    for (const rule of config.rules) {
      if (rule.regex.test(modelRef)) {
        return { adapter: rule.adapter, scopeGlob: rule.scope, args: rule.args };
      }
    }
  }
  return { adapter: "generic", scopeGlob: computeScopeGlob(modelRef) ?? catchallScope, args: {} };
}
