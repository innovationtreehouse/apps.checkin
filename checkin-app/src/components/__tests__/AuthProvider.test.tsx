import React from 'react';
import { render } from '@testing-library/react';
import AuthProvider, { expireSession, viewerFromSession } from '../AuthProvider';

const { useViewer } = jest.requireActual<typeof import('@checkin/component-ui')>('@checkin/component-ui');

jest.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="session-provider">{children}</div>,
  useSession: () => ({ data: { user: { id: 7, isFinance: true, ageBand: 'adult' } } }),
}));

function ShowViewer() {
  return <span>{JSON.stringify(useViewer())}</span>;
}

describe('AuthProvider', () => {
  it('renders its children within the SessionProvider', () => {
    const { getByTestId, getByText } = render(
      <AuthProvider>
        <div>Test Child Component</div>
      </AuthProvider>
    );

    expect(getByTestId('session-provider')).toBeDefined();
    expect(getByText('Test Child Component')).toBeDefined();
  });

  it('gives package UIs the viewer mapped from the session', () => {
    const { getByText } = render(
      <AuthProvider>
        <ShowViewer />
      </AuthProvider>
    );

    expect(JSON.parse(getByText(/"id":7/).textContent ?? '')).toEqual({
      id: 7,
      ageBand: 'adult',
      isFinance: true,
      isBoardMember: false,
      isOperations: false,
      isInventoryManager: false,
    });
  });

  it('maps a signed-out session to no viewer', () => {
    expect(viewerFromSession(null)).toBeNull();
  });

  it('sends an expired session to / with a full page load, unless already there', () => {
    const assign = jest.fn();
    expireSession({ pathname: '/expense', assign });
    expect(assign).toHaveBeenCalledWith('/');
    assign.mockClear();
    expireSession({ pathname: '/', assign });
    expect(assign).not.toHaveBeenCalled();
  });
});
