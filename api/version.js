'use strict';
// Returns the current Vercel deployment ID.
// VERCEL_DEPLOYMENT_ID is injected automatically by Vercel on every deploy — it
// changes every single time the project is redeployed, so clients can compare
// their cached ID against this endpoint to detect when a new version is live.
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    v: process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || 'dev'
  });
};
