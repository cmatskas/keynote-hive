/**
 * Startup routing — decides whether a launch lands on the main window or the
 * credentials page.
 *
 * Extracted from main.js so it can be unit tested. It only calls methods on the
 * context it's handed, so a test can supply a fake one and never construct the
 * real Electron-dependent managers.
 */

const AWSValidator = require('./models/awsValidator');
const logger = require('electron-log/main');

/**
 * Decide where to send the user at launch.
 *
 * The important case is the third one. Being unable to *reach* AWS is not the
 * same as having bad credentials, but this used to treat them identically and
 * open the credentials page — which put every local feature (conversations,
 * work history, skills, showflow) behind a network connection they don't need.
 * When stored credentials fail validation only because we're offline, boot into
 * the main window and let the offline banner explain the situation.
 *
 * Note the deliberate ordering: `initializeAWSClients()` runs *before*
 * validation, so if we're merely offline the clients are already built and start
 * working the moment connectivity returns, with no re-initialisation. Moving
 * that call after the validation check would silently break reconnect — there's
 * a test guarding it.
 *
 * @param {object} ctx - app context (credentialsManager, initializeAWSClients)
 * @returns {Promise<'main'|'credentials'>}
 */
async function resolveStartupRoute(ctx) {
  const hasCredentials = await ctx.credentialsManager.hasCredentials();
  if (!hasCredentials) return 'credentials';

  try {
    ctx.currentCredentials = await ctx.credentialsManager.loadCredentials();
    ctx.initializeAWSClients(ctx.currentCredentials);

    const validator = new AWSValidator(ctx.currentCredentials);
    const result = await validator.quickValidate();

    if (result.valid) return 'main';
    if (result.offline) {
      logger.warn('[startup] offline — booting into main window with stored credentials unverified');
      return 'main';
    }
    return 'credentials';
  } catch (err) {
    logger.error('Error validating credentials:', err);
    return 'credentials';
  }
}

module.exports = { resolveStartupRoute };
