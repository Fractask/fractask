import { Command } from 'clipanion';
import { AmbiguousIdError, CycleError, NotFoundError } from '@getshit/core';

export abstract class BaseCommand extends Command {
  protected abstract run(): Promise<number | void>;

  override async execute(): Promise<number | void> {
    try {
      return await this.run();
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof AmbiguousIdError ||
        err instanceof CycleError
      ) {
        this.context.stderr.write(`error: ${err.message}\n`);
        return 2;
      }
      if (err instanceof Error && err.name === 'ZodError') {
        this.context.stderr.write(`error: invalid input\n${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }
}
