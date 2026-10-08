import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError, fieldErrors, toProblem } from '../api/problem';
import { ProblemAlert } from './ProblemAlert';

describe('problem+json rendering', () => {
  const problem = toProblem(
    400,
    {
      type: 'https://ecloud.example/problems/validation',
      title: 'Validation Failed',
      status: 400,
      detail: 'One or more request fields are invalid.',
      request_id: 'req-abcdef12',
      errors: [
        { path: 'body.download_rate_kbps', message: 'must be >= 0' },
        { path: 'body.name', message: 'required' },
      ],
    },
    'Bad Request',
  );

  it('shows title, status, detail, field errors and request id', () => {
    render(<ProblemAlert error={new ApiError(problem)} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Validation Failed');
    expect(alert).toHaveTextContent('HTTP 400');
    expect(alert).toHaveTextContent('One or more request fields are invalid.');
    expect(alert).toHaveTextContent('body.download_rate_kbps: must be >= 0');
    expect(alert).toHaveTextContent('req-abcdef12');
  });

  it('maps field errors to form fields', () => {
    expect(fieldErrors(problem)).toEqual({ download_rate_kbps: 'must be >= 0', name: 'required' });
  });

  it('renders nothing without an error and a plain message for non-API errors', () => {
    const { container } = render(<ProblemAlert error={null} />);
    expect(container).toBeEmptyDOMElement();
    render(<ProblemAlert error={new Error('boom')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('falls back to the HTTP status text for non-problem bodies', () => {
    expect(toProblem(503, 'gateway', 'Service Unavailable')).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
    });
  });
});
