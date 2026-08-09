// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import { codexConfigPath, codexHome } from '../paths.js';

export default {
  id: 'codex',
  name: 'Codex CLI',
  detect() {
    return {
      installed: fs.existsSync(codexHome()),
      configPath: codexConfigPath(),
    };
  },
};
