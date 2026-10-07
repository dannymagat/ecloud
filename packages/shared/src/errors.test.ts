import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  isAppError,
  toProblem,
} from './errors.js';

describe('AppError hierarchy -> ProblemDetails', () => {
  it('maps each subclass to the RFC 9457 document', () => {
    expect(new NotFoundError('Site', 'abc').toProblem('/api/v1/sites/abc')).toEqual({
      type: 'urn:ecloud:problem:not-found',
      title: 'Not Found',
      status: 404,
      detail: 'Site abc not found.',
      instance: '/api/v1/sites/abc',
      resource: 'Site',
      id: 'abc',
    });
    expect(new UnauthorizedError().toProblem()).toMatchObject({
      status: 401,
      title: 'Unauthorized',
    });
    expect(new ForbiddenError().toProblem()).toMatchObject({ status: 403, title: 'Forbidden' });
    expect(new ConflictError({ detail: 'slug taken' }).toProblem()).toMatchObject({
      status: 409,
      detail: 'slug taken',
    });
  });

  it('ValidationError carries issues as the `errors` extension', () => {
    const error = new ValidationError([{ path: 'body.vlan_id', message: 'must be 1-4094' }]);
    const problem = error.toProblem();
    expect(problem.status).toBe(400);
    expect(problem.type).toBe('urn:ecloud:problem:validation');
    expect(problem.errors).toEqual([{ path: 'body.vlan_id', message: 'must be 1-4094' }]);
  });

  it('extensions cannot override the standard members', () => {
    const error = new AppError(418, 'teapot', 'Teapot', {
      extensions: { status: 200, title: 'nope', custom: 1 },
    });
    expect(error.toProblem()).toEqual({
      type: 'urn:ecloud:problem:teapot',
      title: 'Teapot',
      status: 418,
      custom: 1,
    });
    expect(error.name).toBe('AppError');
    expect(new NotFoundError('X').name).toBe('NotFoundError');
    expect(isAppError(error)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('toProblem hides details of unknown errors', () => {
    const problem = toProblem(new Error('postgres://user:secret@host/db failed'), '/x');
    expect(problem).toEqual({
      type: 'urn:ecloud:problem:internal',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: '/x',
    });
    expect(JSON.stringify(problem)).not.toContain('secret');
  });
});
