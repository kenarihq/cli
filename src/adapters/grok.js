// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import { grokConfigPath, grokHome } from '../paths.js';

export default {
  id: 'grok',
  name: 'Grok Build',
  detect() {
    return {
      installed: fs.existsSync(grokHome()),
      configPath: grokConfigPath(),
    };
  },
};
