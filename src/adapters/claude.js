// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import { claudeConfigDir, claudeSettingsPath } from '../paths.js';

export default {
  id: 'claude',
  name: 'Claude Code',
  detect() {
    return {
      installed: fs.existsSync(claudeConfigDir()),
      configPath: claudeSettingsPath(),
    };
  },
};
