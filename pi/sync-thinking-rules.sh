#!/usr/bin/env bash
# Sync `reasoning` / `thinkingLevelMap` in models.json from pi's model catalog.
#
# pi's own provider catalogs (node_modules/@earendil-works/pi-ai/dist/providers/
# data/*.json) know, per model, whether thinking exists and which thinking levels
# the provider actually accepts. Custom providers in models.json repeat those
# fields by hand, so they drift on every catalog refresh or model rename.
#
# Matching, in order:
#   1. provider baseUrl equal to a catalog provider's baseUrl  -> that catalog only
#   2. per-model ALIASES entry (`ours=catalog-model`, optional
#      `ours=catalog-provider/catalog-model`)
#   3. model id / name match across all catalogs, only when every catalog entry
#      for that id agrees on reasoning + thinkingLevelMap
# Anything else is reported as unmapped and left untouched — a wrong map sends an
# effort value the provider rejects, so silence beats guessing.
#
# Only `reasoning` and `thinkingLevelMap` are written; no other field is touched.
#
# Usage: sync-thinking-rules.sh [--dry-run] [--write] [models.json]
#   default is --dry-run; --write rewrites the file.
set -euo pipefail

PYTHON="${PYTHON:-python3}"
exec "$PYTHON" - "$@" <<'PY'
import json, os, shutil, sys
from collections import OrderedDict

LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

# Custom model id -> catalog model id (or catalog-provider/model-id).
ALIASES = {
    # "deepseek-v4-pro-0831": "deepseek-v4-pro-0813",
}

# "provider/model-id" -> thinkingLevelMap entries to force after the catalog
# sync. Only for levels verified by hand against the live gateway, where the
# catalogs disagree or lag behind. A level absent from the catalogs is simply
# not offered, so pinning one means pi will send that exact effort value.
OVERRIDES = {
    # DeepSeek V4.1 generation: the gateway accepts xhigh for both builds, but
    # every qwen-token-plan* catalog entry nulls it (only huggingface maps it,
    # and only for the base id). V4-generation models stay catalog-only.
    "provider1/deepseek-v4.1-flash": {"xhigh": "xhigh"},
    "provider1/deepseek-v4.1-flash-1017": {"xhigh": "xhigh"},
}

CATALOG_ROOTS = [
    "/opt/bun/install/global/node_modules",
    os.path.expanduser("~/.bun/install/global/node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
]


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def catalog_dir():
    explicit = os.environ.get("PI_AI_DATA")
    if explicit:
        return explicit
    candidates = []
    pi = shutil.which("pi")
    if pi:
        pkg = os.path.dirname(os.path.dirname(os.path.realpath(pi)))
        candidates.append(os.path.join(os.path.dirname(pkg), "pi-ai", "dist", "providers", "data"))
    candidates += [os.path.join(root, "@earendil-works", "pi-ai", "dist", "providers", "data")
                   for root in CATALOG_ROOTS]
    for path in candidates:
        if os.path.isdir(path):
            return path
    die("pi model catalog not found; set PI_AI_DATA to .../pi-ai/dist/providers/data")


def norm_base(url):
    return (url or "").rstrip("/").lower()


def norm_id(model_id):
    return "".join(ch for ch in model_id.lower() if ch.isalnum())


def shape(model):
    """The two fields we sync, in hashable/comparable form."""
    mapping = model.get("thinkingLevelMap") or {}
    return (bool(model.get("reasoning")),
            tuple(sorted((k, "" if v is None else v) for k, v in mapping.items())))


def load_catalog(path):
    scope = {}
    for name in sorted(os.listdir(path)):
        if name.startswith(".") or not name.endswith(".json"):  # .manifest.json
            continue
        with open(os.path.join(path, name)) as fh:
            data = json.load(fh)
        provider = name[: -len(".json")]
        for models in data.values():
            for model in models.values():
                scope.setdefault(provider, []).append(model)
    return scope


def by_base_url(scope, base_url):
    wanted = norm_base(base_url)
    return {p: ms for p, ms in scope.items()
            if wanted and any(norm_base(m.get("baseUrl")) == wanted for m in ms)}


def global_matches(scope, model):
    for key in (lambda m: m.get("id") == model["id"],
                lambda m: m.get("name") == model.get("name"),
                lambda m: norm_id(m.get("id", "")) == norm_id(model["id"])):
        hits = [(p, m) for p, ms in scope.items() for m in ms if key(m)]
        if hits:
            return hits
    return []


def resolve(scope, provider_id, provider, model):
    alias = ALIASES.get(model["id"])
    if alias:
        prov, _, mid = alias.rpartition("/") if "/" in alias else (None, "", alias)
        hits = [(p, m) for p, ms in scope.items() if prov in (None, p)
                for m in ms if m.get("id") == mid]
        if len(hits) == 1:
            return hits[0]
        return None

    same_provider = by_base_url(scope, provider.get("baseUrl"))
    hits = [(p, m) for p, ms in same_provider.items() for m in ms
            if m.get("id") == model["id"]]
    if hits and len({shape(m) for _, m in hits}) == 1:
        return hits[0]

    hits = global_matches(scope, model)
    if len({shape(m) for _, m in hits}) == 1:
        return hits[0]
    return None


def main(argv):
    write = "--write" in argv
    paths = [a for a in argv if not a.startswith("-")]
    if any(a not in ("--write", "--dry-run") for a in argv if a.startswith("-")):
        die("unknown option; use --dry-run or --write")
    target = paths[0] if paths else os.path.join(
        os.environ.get("PI_CODING_AGENT_DIR", os.path.expanduser("~/.pi/agent")), "models.json")
    if not os.path.isfile(target):
        die(f"{target} not found")

    scope = load_catalog(catalog_dir())
    with open(target) as fh:
        config = json.load(fh, object_pairs_hook=OrderedDict)

    changed = unmapped = 0
    for provider_id, provider in config["providers"].items():
        for model in provider.get("models", []):
            hit = resolve(scope, provider_id, provider, model)
            if hit is None:
                if f"{provider_id}/{model['id']}" not in OVERRIDES:
                    unmapped += 1
                    print(f"  ?  {provider_id}/{model['id']}: no catalog match")
                    continue
                hit = ("override", {"reasoning": model.get("reasoning")})
            catalog_provider, ref = hit
            before = shape(model)
            new_map = OrderedDict(ref.get("thinkingLevelMap") or {})
            for level, value in OVERRIDES.get(f"{provider_id}/{model['id']}", {}).items():
                new_map[level] = value
            new_map = OrderedDict((k, v) for k, v in new_map.items() if k in LEVELS) or None
            after = shape({"reasoning": ref.get("reasoning"), "thinkingLevelMap": new_map})
            if before == after:
                continue
            changed += 1
            print(f"  ~  {provider_id}/{model['id']}  (catalog {catalog_provider})")
            if before[0] != after[0]:
                print(f"       reasoning: {before[0]} -> {after[0]}")
            if before[1] != after[1]:
                old = model.get("thinkingLevelMap") or {}
                new = new_map or {}
                for level in LEVELS:
                    if old.get(level) != new.get(level) and (level in old or level in new):
                        print(f"       {level}: {old.get(level)!r} -> {new.get(level)!r}")
            model["reasoning"] = after[0]
            if new_map:
                model["thinkingLevelMap"] = new_map
            else:
                model.pop("thinkingLevelMap", None)

    print(f"{target}: {changed} model(s) to update, {unmapped} unmapped")
    if changed and write:
        with open(target, "w") as fh:
            fh.write(json.dumps(config, indent=2, ensure_ascii=False) + "\n")
        print("written")
    elif changed:
        print("dry run — pass --write to apply")
    return 0


sys.exit(main(sys.argv[1:]))
PY