#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const contractsDir = __dirname;
const fixturesDir = path.join(contractsDir, 'fixtures', 'page-scene-v1');
const ajvModule = process.env.AJV_MODULE || path.join(contractsDir, '..', 'frontend', 'node_modules', 'ajv');
const Ajv = require(ajvModule);
const schema = JSON.parse(fs.readFileSync(path.join(contractsDir, 'page-scene-v1.schema.json'), 'utf8'));
const validateSchema = new Ajv({allErrors: true, jsonPointers: true, logger: false}).compile(schema);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function logicalSceneDigest(scene) {
  const logical = clone(scene);
  logical.scene_kind = 'logical';
  delete logical.resolved_layout;
  return crypto.createHash('sha256').update(canonicalize(logical), 'utf8').digest('hex');
}

function decodePointer(pointer) {
  return pointer === '' ? [] : pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function applyOperation(document, operation) {
  const parts = decodePointer(operation.path);
  let parent = document;
  for (const part of parts.slice(0, -1)) parent = parent[part];
  const key = parts.at(-1);
  if (operation.op === 'replace' || operation.op === 'add') parent[key] = operation.value;
  else if (operation.op === 'remove') Array.isArray(parent) ? parent.splice(Number(key), 1) : delete parent[key];
  else throw new Error(`unsupported fixture operation ${operation.op}`);
}

function uniqueIds(records, key, label, errors) {
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record[key])) errors.push(`duplicate ${label} ${record[key]}`);
    ids.add(record[key]);
  }
  return ids;
}

function semanticErrors(scene) {
  const errors = [];
  if (!validateSchema(scene)) return validateSchema.errors.map((error) => `schema ${error.dataPath || '/'} ${error.message}`);
  const fragmentIds = uniqueIds(scene.fragments, 'fragment_id', 'fragment', errors);
  const ownerIds = uniqueIds(scene.owners, 'owner_id', 'owner', errors);
  const assetKinds = new Map();
  for (const asset of scene.assets) {
    if (assetKinds.has(asset.asset_id)) errors.push(`duplicate asset ${asset.asset_id}`);
    assetKinds.set(asset.asset_id, asset.kind);
  }
  const cleanupById = new Map();
  for (const cleanup of scene.cleanup_artifacts) {
    if (cleanupById.has(cleanup.cleanup_id)) errors.push(`duplicate cleanup ${cleanup.cleanup_id}`);
    cleanupById.set(cleanup.cleanup_id, cleanup);
  }
  const policyByOwner = new Map();
  for (const policy of scene.policies) {
    if (!ownerIds.has(policy.owner_id)) errors.push(`policy references unknown owner ${policy.owner_id}`);
    if (policyByOwner.has(policy.owner_id)) errors.push(`multiple policies for owner ${policy.owner_id}`);
    policyByOwner.set(policy.owner_id, policy);
  }
  for (const ownerId of ownerIds) if (!policyByOwner.has(ownerId)) errors.push(`owner ${ownerId} lacks a policy`);
  const ownedFragments = new Set();
  for (const owner of scene.owners) {
    for (const fragmentId of owner.fragment_ids) {
      if (!fragmentIds.has(fragmentId)) errors.push(`owner ${owner.owner_id} references unknown fragment ${fragmentId}`);
      if (ownedFragments.has(fragmentId)) errors.push(`fragment ${fragmentId} has multiple owners`);
      ownedFragments.add(fragmentId);
    }
  }
  for (const fragmentId of fragmentIds) if (!ownedFragments.has(fragmentId)) errors.push(`fragment ${fragmentId} lacks an owner`);
  const effectiveAction = (ownerId) => {
    const policy = policyByOwner.get(ownerId);
    return policy && (policy.user_override || policy.action);
  };
  for (const cleanup of scene.cleanup_artifacts) {
    if (cleanup.source_sha256 !== scene.page.source.sha256) errors.push(`cleanup ${cleanup.cleanup_id} has wrong source hash`);
    if (assetKinds.get(cleanup.mask_asset_id) !== 'glyph_mask') errors.push(`cleanup ${cleanup.cleanup_id} lacks a glyph mask asset`);
    if (assetKinds.get(cleanup.patch_asset_id) !== 'cleanup_patch') errors.push(`cleanup ${cleanup.cleanup_id} lacks a cleanup patch asset`);
    for (const ownerId of cleanup.owner_ids) {
      if (!ownerIds.has(ownerId)) errors.push(`cleanup ${cleanup.cleanup_id} references unknown owner ${ownerId}`);
      if (effectiveAction(ownerId) !== 'replace') errors.push(`cleanup ${cleanup.cleanup_id} is not authorized for ${ownerId}`);
    }
  }
  const objectIds = new Set();
  for (const object of scene.objects) {
    if (objectIds.has(object.object_id)) errors.push(`duplicate object ${object.object_id}`);
    objectIds.add(object.object_id);
    if (object.kind !== 'automatic_text') continue;
    if (effectiveAction(object.owner_id) !== 'replace') errors.push(`automatic object ${object.object_id} is not authorized for ${object.owner_id}`);
    for (const cleanupId of object.cleanup_ids) {
      const cleanup = cleanupById.get(cleanupId);
      if (!cleanup) errors.push(`automatic object ${object.object_id} references missing cleanup ${cleanupId}`);
      else if (!cleanup.owner_ids.includes(object.owner_id)) errors.push(`automatic object ${object.object_id} does not own cleanup ${cleanupId}`);
    }
  }
  if (scene.scene_kind === 'resolved') {
    const resolvedIds = new Set(scene.resolved_layout.objects.map((object) => object.object_id));
    for (const object of scene.objects) if (!resolvedIds.has(object.object_id)) errors.push(`resolved layout lacks object ${object.object_id}`);
    for (const objectId of resolvedIds) if (!objectIds.has(objectId)) errors.push(`resolved layout adds object ${objectId}`);
    if (scene.resolved_layout.logical_scene_sha256 !== logicalSceneDigest(scene)) errors.push('resolved layout has wrong logical scene digest');
  }
  return errors;
}

function validateFixture(name, scene, expectedValid) {
  const errors = semanticErrors(scene);
  if (expectedValid && errors.length) throw new Error(`${name} must be valid:\n${errors.join('\n')}`);
  if (!expectedValid && !errors.length) throw new Error(`${name} must be rejected`);
  console.log(`${expectedValid ? 'valid' : 'invalid'} ${name}`);
}

const validFixtures = ['logical-valid.json', 'resolved-valid.json', 'overlap-preserve-valid.json'];
for (const fixture of validFixtures) validateFixture(fixture, JSON.parse(fs.readFileSync(path.join(fixturesDir, fixture), 'utf8')), true);
const nonFinite = fs.readFileSync(path.join(fixturesDir, 'non-finite-geometry.json'), 'utf8');
try {
  JSON.parse(nonFinite);
  throw new Error('non-finite-geometry.json must not parse as JSON');
} catch (error) {
  if (error.message === 'non-finite-geometry.json must not parse as JSON') throw error;
  console.log('invalid non-finite-geometry');
}
function validateInvalidCases(caseFile) {
  const invalidCases = JSON.parse(fs.readFileSync(path.join(fixturesDir, caseFile), 'utf8'));
  const base = JSON.parse(fs.readFileSync(path.join(fixturesDir, invalidCases.base_fixture), 'utf8'));
  for (const testCase of invalidCases.cases) {
    const document = clone(base);
    for (const operation of testCase.operations) applyOperation(document, operation);
    validateFixture(testCase.name, document, false);
  }
}

validateInvalidCases('invalid-cases.json');
validateInvalidCases('resolved-invalid-cases.json');
console.log('page-scene/v1 fixtures: PASS');
