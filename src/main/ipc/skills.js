const fs = require('fs').promises;
const path = require('path');

function register(ipcMain, ctx) {
  ipcMain.handle('get-prompt-templates', async () => {
    return await ctx.customPromptsManager.getAll();
  });

  ipcMain.handle('add-custom-prompt', async (event, prompt) => {
    return await ctx.customPromptsManager.add(prompt);
  });

  ipcMain.handle('update-custom-prompt', async (event, { id, updates }) => {
    return await ctx.customPromptsManager.update(id, updates);
  });

  ipcMain.handle('delete-custom-prompt', async (event, id) => {
    return await ctx.customPromptsManager.delete(id);
  });

  ipcMain.handle('get-custom-prompts', async () => {
    return await ctx.customPromptsManager.getAll();
  });

  ipcMain.handle('get-skills', async () => {
    return ctx.skillsManager.getSkills();
  });

  ipcMain.handle('toggle-skill', async (event, { name, enabled }) => {
    return await ctx.skillsManager.toggleSkill(name, enabled);
  });

  ipcMain.handle('refresh-skills', async () => {
    return await ctx.skillsManager.refresh();
  });

  ipcMain.handle('open-skills-folder', async () => {
    await ctx.skillsManager.openSkillsFolder();
  });

  ipcMain.handle('get-skill-content', async (event, name) => {
    const skill = ctx.skillsManager.getSkill(name);
    if (!skill) return null;
    return await fs.readFile(skill.location, 'utf8');
  });

  ipcMain.handle('save-skill-content', async (event, { name, content }) => {
    const skill = ctx.skillsManager.getSkill(name);
    if (!skill) throw new Error('Skill not found');
    await fs.writeFile(skill.location, content, 'utf8');
    await ctx.skillsManager.refresh();
    return true;
  });

  ipcMain.handle('delete-skill', async (event, name) => {
    const skill = ctx.skillsManager.getSkill(name);
    if (!skill) throw new Error('Skill not found');
    await fs.rm(path.dirname(skill.location), { recursive: true, force: true });
    await ctx.skillsManager.refresh();
    return true;
  });

  ipcMain.handle('create-skill', async (event, { name, content }) => {
    const dir = path.join(ctx.skillsManager.userSkillsDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf8');
    await ctx.skillsManager.refresh();
    return true;
  });
}

module.exports = { register };
