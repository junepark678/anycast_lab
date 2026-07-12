import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPLIANCE_DRAG_MIME, Palette } from './Palette';

afterEach(cleanup);

function dragTransfer() {
  return {
    effectAllowed: 'none',
    setData: vi.fn(),
  };
}

describe('Palette', () => {
  it('adds an appliance by click as an accessible drag fallback', () => {
    const onAdd = vi.fn();
    render(<Palette onAdd={onAdd} />);

    fireEvent.click(screen.getByRole('button', { name: /FRRouting/ }));

    expect(onAdd).toHaveBeenCalledOnce();
    expect(onAdd).toHaveBeenCalledWith('frr');
  });

  it('publishes both the application MIME payload and a text fallback while dragging', () => {
    render(<Palette onAdd={vi.fn()} />);
    const bird = screen.getByRole('button', { name: /BIRD/ });
    const dataTransfer = dragTransfer();

    fireEvent.dragStart(bird, { dataTransfer });

    expect(dataTransfer.effectAllowed).toBe('copy');
    expect(dataTransfer.setData).toHaveBeenNthCalledWith(1, APPLIANCE_DRAG_MIME, 'bird');
    expect(dataTransfer.setData).toHaveBeenNthCalledWith(2, 'text/plain', 'bird');
    expect(bird).toHaveClass('is-dragging');

    fireEvent.dragEnd(bird);
    expect(bird).not.toHaveClass('is-dragging');
  });

  it('prevents click and drag mutations while disabled', () => {
    const onAdd = vi.fn();
    render(<Palette onAdd={onAdd} disabled />);
    const routeServer = screen.getByRole('button', { name: /Route server/ });
    const dataTransfer = dragTransfer();

    expect(routeServer).toBeDisabled();
    expect(routeServer).toHaveAttribute('draggable', 'false');
    fireEvent.click(routeServer);
    fireEvent.dragStart(routeServer, { dataTransfer });

    expect(onAdd).not.toHaveBeenCalled();
    expect(dataTransfer.setData).not.toHaveBeenCalled();
    expect(routeServer).not.toHaveClass('is-dragging');
  });
});
