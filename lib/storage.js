// Atomic per-project JSON storage. One file per project under data/projects/.
// Mirrors the Sequence app's storage philosophy: plain JSON, atomic writes
// (write temp + rename) so a crash mid-write can't corrupt a project.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'projects');
const GEN_DIR = process.env.GEN_DIR || path.join(__dirname, '..', 'data', 'generated');
const ATTACH_DIR = process.env.ATTACH_DIR || path.join(__dirname, '..', 'data', 'attachments');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GEN_DIR, { recursive: true });
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
}
ensureDirs();

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function projectPath(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad project id');
  return path.join(DATA_DIR, id + '.json');
}

function generatedDir(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad project id');
  return path.join(GEN_DIR, id);
}

// Uploaded reference files (PDFs, docs, codebase zips) live here, one dir per
// project. Source of truth; copied into the generated tree's reference/ folder
// at generate time so they ride along in the export bundle.
function attachmentsDir(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad project id');
  return path.join(ATTACH_DIR, id);
}

function writeAtomic(file, data) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function listProjects() {
  ensureDirs();
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function getProject(id) {
  try { return JSON.parse(fs.readFileSync(projectPath(id), 'utf-8')); }
  catch { return null; }
}

function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  writeAtomic(projectPath(project.id), JSON.stringify(project, null, 2));
  return project;
}

function deleteProject(id) {
  try { fs.unlinkSync(projectPath(id)); } catch {}
  try { fs.rmSync(generatedDir(id), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(attachmentsDir(id), { recursive: true, force: true }); } catch {}
}

module.exports = {
  DATA_DIR, GEN_DIR, ATTACH_DIR, newId, projectPath, generatedDir, attachmentsDir,
  listProjects, getProject, saveProject, deleteProject,
};
