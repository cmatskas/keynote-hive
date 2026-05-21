function register(ipcMain, ctx, { invokeBedrockNoKB }) {
  ipcMain.handle('list-conversations', async () => {
    return await ctx.conversationManager.list();
  });

  ipcMain.handle('load-conversation', async (event, id) => {
    return await ctx.conversationManager.load(id);
  });

  ipcMain.handle('save-conversation', async (event, conversation) => {
    return await ctx.conversationManager.save(conversation);
  });

  ipcMain.handle('delete-conversation', async (event, id) => {
    await ctx.conversationManager.delete(id);
    return true;
  });

  ipcMain.handle('create-conversation', async (event, firstPrompt) => {
    return ctx.conversationManager.create(firstPrompt);
  });

  ipcMain.handle('compress-conversation', async (event, { model, conversation }) => {
    const oldMessages = conversation.messages.slice(0, -4);
    const historyText = oldMessages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    const summaryPrompt = `Summarize the following conversation history concisely, preserving all key facts, decisions, and context that would be needed to continue the conversation:\n\n${historyText}`;
    const summary = await invokeBedrockNoKB(model, summaryPrompt);
    return ctx.conversationManager.applyCompression(conversation, summary);
  });
}

module.exports = { register };
