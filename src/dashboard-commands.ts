import {Command} from 'commander';
import path = require('path');
import {readFileSync} from 'fs';
const yaml = require('js-yaml');

const dashboardPackageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
);

export function registerDashboardCommands(program: Command) {
  const dashboard = program
    .command('dashboard')
    .description('Dashboard related commands');

  dashboard
    .command('version')
    .description(
      'Shows the installed version, latest version and minimum version of the operator dashboard'
    )
    .action(() => {
      console.log( yaml.dump({
        current_version: dashboardPackageJson.version,
        minimum_version: "1.0.0", //TODO query from some official online source
        latest_version: "1.0.0",
      }));
    });
}
