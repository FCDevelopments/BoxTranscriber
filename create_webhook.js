'use strict';
require('dotenv').config();
const axios = require('axios');

async function main() {
  const token = process.env.BOX_DEVELOPER_TOKEN;
  const folderId = process.env.BOX_FOLDER_ID;
  const webhookUrl = process.argv[2];

  if (!webhookUrl) {
    console.error('Usage: node create_webhook.js https://your-ngrok-url/webhook');
    process.exit(1);
  }
  // Fail fast with a clear message rather than sending an unauthenticated /
  // malformed request to Box.
  const missing = [
    !token && 'BOX_DEVELOPER_TOKEN',
    !folderId && 'BOX_FOLDER_ID',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(', ')} (set them in .env)`);
    process.exit(1);
  }

  console.log(`Creating V2 webhook on folder ${folderId} -> ${webhookUrl}`);

  const res = await axios.post(
    'https://api.box.com/2.0/webhooks',
    {
      target: { type: 'folder', id: folderId },
      address: webhookUrl,
      triggers: ['FILE.UPLOADED'],
    },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );

  console.log('Webhook created!');
  console.log('  ID:      ', res.data.id);
  console.log('  Target:  ', res.data.target);
  console.log('  Address: ', res.data.address);
  console.log('  Triggers:', res.data.triggers);
}

main().catch(err => {
  if (err.response) {
    console.error('HTTP status:', err.response.status);
    console.error('Response headers:', JSON.stringify(err.response.headers, null, 2));
    console.error('Response body:', JSON.stringify(err.response.data, null, 2));
  } else {
    console.error('Error:', err.message);
  }
});
