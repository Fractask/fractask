#!/usr/bin/env node
import { Builtins, Cli } from 'clipanion';

// Don't crash when stdout is closed early (e.g. piping to `head`).
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
import { AddCommand } from './commands/add.js';
import { LsCommand } from './commands/ls.js';
import { ShowCommand } from './commands/show.js';
import { EditCommand } from './commands/edit.js';
import { DoneCommand, DoingCommand, ReopenCommand } from './commands/status.js';
import { MvCommand } from './commands/mv.js';
import { NoteCommand } from './commands/note.js';
import { RmCommand } from './commands/rm.js';

const [, , ...args] = process.argv;

const cli = new Cli({
  binaryLabel: 'getshit',
  binaryName: 'getshit',
  binaryVersion: '0.0.0',
});

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
cli.register(AddCommand);
cli.register(LsCommand);
cli.register(ShowCommand);
cli.register(EditCommand);
cli.register(DoneCommand);
cli.register(DoingCommand);
cli.register(ReopenCommand);
cli.register(MvCommand);
cli.register(NoteCommand);
cli.register(RmCommand);

cli.runExit(args);
