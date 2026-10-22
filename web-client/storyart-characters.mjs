import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const IMAGE = /\.(?:png|jpe?g|webp)$/i;
const MAX_MANIFEST_BYTES = 4_000_000;

const CATEGORIES = [
  { id: 'identity', label: 'Персонаж' },
  { id: 'projections', label: 'Проекции' },
  { id: 'wardrobe', label: 'Одежда' },
  { id: 'accessories', label: 'Аксессуары' },
  { id: 'scenes', label: 'Готовые арты с ним (сцены)' }
];

const DIRECTORY_CATEGORIES = [
  ['00_APPROVED_BASE', 'identity'],
  ['03_CHARACTER_REFERENCES/01_FACE', 'identity'],
  ['03_CHARACTER_REFERENCES/02_BODY', 'projections'],
  ['03_CHARACTER_REFERENCES/03_WARDROBE', 'wardrobe'],
  ['03_CHARACTER_REFERENCES/04_ACCESSORIES', 'accessories'],
  ['02_SCENES', 'scenes']
];

const text = (value, limit = 1000) =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit)
    : '';

const hash = value => createHash('sha256').update(value).digest('hex');

function unavailablePath() {
  return Object.assign(new Error('Недопустимый путь в реестре персонажей StoryArt.'), {
    status: 403,
    expose: true
  });
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404, expose: true });
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, expose: true });
}

function pathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function portableAbsolute(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function relativeFromAbsolute(value, root) {
  if (!portableAbsolute(value)) return null;

  if (path.isAbsolute(value) && path.isAbsolute(root)) {
    const relative = path.relative(root, path.resolve(value));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return relative.replaceAll('\\', '/');
  }

  const rootWin = path.win32.resolve(root);
  const valueWin = path.win32.resolve(value);
  const relative = path.win32.relative(rootWin, valueWin);
  if (!relative || relative === '..' || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) return null;
  return relative.replaceAll('\\', '/');
}

function normalizeRelative(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  const normalized = value.trim().replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some(part => !part || part === '.' || part === '..')
  ) return null;
  return normalized;
}

export function createStoryArtCharacters({ projectPath, safeFile, parseCsv, imageType }) {
  if (typeof safeFile !== 'function' || typeof parseCsv !== 'function' || typeof imageType !== 'function') {
    throw new TypeError('Нужны safeFile, parseCsv и imageType.');
  }

  const root = path.resolve(projectPath);

  async function checkedDirectory(relative, { optional = false } = {}) {
    const base = await fs.realpath(root);
    if (base.toLowerCase() !== root.toLowerCase() || (await fs.lstat(root)).isSymbolicLink()) {
      throw Object.assign(new Error('Корень StoryArt недоступен.'), { status: 403, expose: true });
    }

    let normalized = normalizeRelative(relative);
    if (!normalized) throw unavailablePath();

    let current = root;
    for (const part of normalized.split('/')) {
      current = path.join(current, part);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if (optional && error?.code === 'ENOENT') return null;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unavailablePath();
      const actual = await fs.realpath(current);
      if (!pathWithin(base, actual)) throw unavailablePath();
    }
    return current;
  }

  async function optionalFile(relative, maxBytes) {
    try {
      return await safeFile(root, relative, maxBytes);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  function validateId(value, label) {
    if (typeof value !== 'string' || !ID.test(value)) throw invalid(`Некорректный ${label}.`);
  }

  function normalizeOwnedPath(value, characterRoot) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;

    let relative;
    if (portableAbsolute(value)) {
      relative = relativeFromAbsolute(value, root);
    } else {
      relative = normalizeRelative(value);
      if (relative) {
        const prefix = `${characterRoot}/`;
        if (relative.startsWith(prefix)) {
          // Already rooted at this character.
        } else if (relative.startsWith(`${characterRoot.split('/').slice(0, -1).join('/')}/`)) {
          // A path rooted elsewhere in the style tree must not be re-prefixed.
          return null;
        } else {
          relative = `${characterRoot}/${relative}`;
        }
      }
    }

    if (!relative) return null;
    const prefix = `${characterRoot}/`;
    if (!relative.startsWith(prefix) || !IMAGE.test(relative)) return null;
    if (relative.split('/').some(part => !part || part === '.' || part === '..')) return null;
    return relative;
  }

  function categoryForManifest(item, relative) {
    const hint = text(item.category || item.asset_category || item.primary_role, 100).toUpperCase();
    const status = text(item.status, 100).toUpperCase();
    const stage = text(item.stage || item.stage_id, 100).toUpperCase();

    if (/REJECTED/.test(status) || /(?:^|\/)[^/]*REJECTED[^/]*(?:\/|$)/i.test(relative)) return null;
    if (/WARDROBE|CLOTHING|OUTFIT/.test(hint) || status === 'APPROVED_WARDROBE') return 'wardrobe';
    if (/ACCESSOR/.test(hint) || status === 'APPROVED_ACCESSORY') return 'accessories';
    if (/SCENE|ARTWORK/.test(hint) || status === 'APPROVED_SCENE') return 'scenes';
    if (/PROJECTION|BODY/.test(hint) || /PROJECTION|BODY/.test(stage)) return 'projections';
    if (/IDENTITY|CHARACTER/.test(hint) || /IDENTITY|CHARACTER/.test(stage)) return 'identity';

    const variation = /(?:^|\/)01_VARIATIONS(?:\/|$)/i.test(relative);
    if (variation) return null;
    return null;
  }

  function publicAsset(styleId, characterId, relative, category, metadata = {}) {
    const id = hash(`${styleId}\0${characterId}\0${relative}`).slice(0, 24);
    return {
      id,
      name: text(path.posix.basename(relative), 200),
      url: `/api/storyart/character-image?styleId=${encodeURIComponent(styleId)}&characterId=${encodeURIComponent(characterId)}&assetId=${encodeURIComponent(id)}`,
      category,
      status: metadata.status || 'SAVED_UNVERIFIED',
      description: text(metadata.description, 1000),
      source: text(metadata.source || 'character_workspace', 100),
      previewReason: ''
    };
  }

  async function resolveCharacter(styleId, characterId) {
    validateId(styleId, 'стиль');
    validateId(characterId, 'персонаж');

    const styleRoot = `${styleId}_GENERATIONS`;
    await checkedDirectory(styleRoot);

    const registryFile = await safeFile(root, `${styleRoot}/CHARACTER_REGISTRY.csv`, MAX_MANIFEST_BYTES);
    const rows = parseCsv(registryFile.bytes.toString('utf8'));
    const row = rows.find(item =>
      item.character_id === characterId &&
      String(item.status || '').trim().toUpperCase().startsWith('APPROVED')
    );
    if (!row) throw notFound('Утверждённый персонаж не найден в реестре выбранного стиля.');

    const profilePath = row.profile_path;
    const profileRelative = portableAbsolute(profilePath) ? relativeFromAbsolute(profilePath, root) : null;
    const profileMatch = profileRelative?.match(
      /^([^/]+)_GENERATIONS\/01_APPROVED_CHARACTERS\/([^/]+)\/CHARACTER_PROFILE\.yaml$/i
    );
    if (!profileMatch || profileMatch[1] !== styleId) throw unavailablePath();

    const characterFolder = profileMatch[2];
    const characterRoot = `${styleRoot}/01_APPROVED_CHARACTERS/${characterFolder}`;
    const profile = await safeFile(root, profileRelative, 1_000_000);
    await checkedDirectory(characterRoot);

    const approvedPaths = new Map();
    const addApproved = (rawPath, category) => {
      const relative = normalizeOwnedPath(rawPath, characterRoot);
      if (relative) approvedPaths.set(relative, { category, status: 'APPROVED' });
    };

    addApproved(row.approved_base, 'identity');
    for (const rawPath of String(row.face_references || '').split(';')) addApproved(rawPath, 'identity');
    for (const rawPath of String(row.body_references || '').split(';')) addApproved(rawPath, 'projections');

    return { styleRoot, characterRoot, row, profile, approvedPaths };
  }

  async function readManifest(styleRoot) {
    const file = await optionalFile(`${styleRoot}/GENERATION_MANIFEST.csv`, MAX_MANIFEST_BYTES);
    return file ? parseCsv(file.bytes.toString('utf8')) : [];
  }

  async function collect(styleId, characterId) {
    const resolved = await resolveCharacter(styleId, characterId);
    const { styleRoot, characterRoot, row, approvedPaths } = resolved;
    const assets = Object.fromEntries(CATEGORIES.map(category => [category.id, []]));
    const paths = new Map();
    const excluded = new Set();
    const metadataByPath = new Map();

    // Read manifest first. It is the source of status and descriptions for owned images.
    const manifestRows = await readManifest(styleRoot);
    for (const item of manifestRows) {
      const rawPath = item.style_file;
      if (typeof rawPath !== 'string' || !rawPath.trim()) continue;

      const relative = normalizeOwnedPath(rawPath, characterRoot);
      if (!relative) continue;

      const owner = text(item.character_id, 100);
      const status = text(item.status, 100).toUpperCase();
      if (owner && owner !== characterId) {
        excluded.add(relative);
        continue;
      }
      if (status.includes('REJECTED') || /(?:^|\/)[^/]*REJECTED[^/]*(?:\/|$)/i.test(relative)) {
        excluded.add(relative);
        continue;
      }

      const category = categoryForManifest(item, relative);
      metadataByPath.set(relative, {
        category,
        status: status.startsWith('APPROVED_') || status === 'APPROVED' ? status : '',
        description: item.description || item.notes || '',
        source: 'generation_manifest'
      });
    }

    // A folder is storage, never evidence of approval. Enumerate only registered
    // approved paths, with canonical registry entries first. Never walk saved copies.
    const candidates = new Map(approvedPaths);
    for (const [relative, metadata] of metadataByPath) {
      if (!/^APPROVED(?:_|$)/.test(metadata.status)) continue;
      if (!candidates.has(relative)) candidates.set(relative, metadata);
    }

    const contentSeen = new Set();
    for (const [relative, metadata] of candidates) {
      if (excluded.has(relative)) continue;
      const owned = relative.slice(characterRoot.length + 1);
      if (owned.split('/').slice(0, -1).some(part =>
        /(?:PENDING|REJECTED|DRAFT|STAGING|^TEST$)/i.test(part)
      )) continue;
      const folderCategory = DIRECTORY_CATEGORIES.find(([folder]) =>
        owned.startsWith(`${folder}/`)
      )?.[1];
      const manifestMeta = metadataByPath.get(relative);
      const category = approvedPaths.get(relative)?.category || manifestMeta?.category || folderCategory;
      const variation = owned.startsWith('01_VARIATIONS/') && manifestMeta?.category;
      if ((!folderCategory && !variation) || !category || !assets[category]) continue;

      let file;
      try {
        file = await safeFile(root, relative);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      imageType(file.bytes);
      const digest = hash(file.bytes);
      if (contentSeen.has(digest)) continue;
      contentSeen.add(digest);

      const asset = publicAsset(styleId, characterId, relative, category, {
        status: metadata.status,
        description: manifestMeta?.description || '',
        source: approvedPaths.has(relative) ? 'character_registry' : 'generation_manifest'
      });
      assets[category].push(asset);
      paths.set(asset.id, relative);
    }

    for (const category of CATEGORIES) {
      assets[category.id].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    }

    const categories = CATEGORIES.map(category => ({ ...category, assets: assets[category.id] }));
    const identityCover = assets.identity.find(asset => asset.status === 'APPROVED') || assets.identity[0] || null;

    return {
      detail: {
        styleId,
        character: {
          id: characterId,
          name: text(row.name, 160) || characterId,
          coverUrl: identityCover?.url || '',
          description: text(row.description, 1000)
        },
        categories
      },
      paths
    };
  }

  async function detail(styleId, characterId) {
    return (await collect(styleId, characterId)).detail;
  }

  async function image(styleId, characterId, assetId) {
    validateId(styleId, 'стиль');
    validateId(characterId, 'персонаж');
    validateId(assetId, 'изображение');

    const collected = await collect(styleId, characterId);
    const relative = collected.paths.get(assetId);
    if (!relative) throw notFound('Изображение персонажа не найдено.');

    const file = await safeFile(root, relative);
    return { ...file, ...imageType(file.bytes) };
  }

  return { detail, image };
}
