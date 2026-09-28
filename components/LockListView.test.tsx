import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LockListView } from './LockListView'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(window, 'localStorage', { value: localStorageMock })

describe('LockListView', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('loading state', () => {
    it('should render skeletons while loading', () => {
      render(<LockListView isLoading={true} locks={[]} error={null} filters={{}} />)
      const skeletons = screen.getAllByTestId('lock-skeleton')
      expect(skeletons.length).toBeGreaterThan(0)
    })

    it('should not render locks list while loading', () => {
      render(<LockListView isLoading={true} locks={[]} error={null} filters={{}} />)
      expect(screen.queryByTestId('locks-list')).not.toBeInTheDocument()
    })
  })

  describe('error state', () => {
    it('should render error message', () => {
      render(<LockListView isLoading={false} locks={[]} error="Failed to load locks" filters={{}} />)
      expect(screen.getByText('Failed to load locks')).toBeInTheDocument()
    })

    it('should render retry button on error', () => {
      const onRetry = jest.fn()
      render(<LockListView isLoading={false} locks={[]} error="Failed to load locks" filters={{}} onRetry={onRetry} />)

      const retryButton = screen.getByText('Retry')
      fireEvent.click(retryButton)
      expect(onRetry).toHaveBeenCalled()
    })
  })

  describe('empty states', () => {
    it('should render empty-with-no-filters message when no locks and no filters', () => {
      render(<LockListView isLoading={false} locks={[]} error={null} filters={{}} />)
      expect(screen.getByText(/No locks yet/i)).toBeInTheDocument()
    })

    it('should render empty-with-filters message when no locks but filters applied', () => {
      render(<LockListView isLoading={false} locks={[]} error={null} filters={{ status: 'active' }} />)
      expect(screen.getByText(/No locks match your filters/i)).toBeInTheDocument()
    })

    it('should not show locks list when empty', () => {
      render(<LockListView isLoading={false} locks={[]} error={null} filters={{}} />)
      expect(screen.queryByTestId('locks-list')).not.toBeInTheDocument()
    })
  })

  describe('view mode persistence', () => {
    it('should render card view by default', () => {
      render(<LockListView isLoading={false} locks={[{ id: '1', token: 'USDC' }]} error={null} filters={{}} />)
      expect(screen.getByTestId('card-view')).toBeInTheDocument()
    })

    it('should toggle to table view', () => {
      render(<LockListView isLoading={false} locks={[{ id: '1', token: 'USDC' }]} error={null} filters={{}} />)

      const tableViewButton = screen.getByText('Table')
      fireEvent.click(tableViewButton)

      expect(screen.getByTestId('table-view')).toBeInTheDocument()
    })

    it('should persist table view to localStorage', () => {
      const { unmount } = render(<LockListView isLoading={false} locks={[{ id: '1', token: 'USDC' }]} error={null} filters={{}} />)

      const tableViewButton = screen.getByText('Table')
      fireEvent.click(tableViewButton)

      expect(localStorage.getItem('lockListViewMode')).toBe('table')

      unmount()
    })

    it('should restore view mode from localStorage on remount', () => {
      localStorage.setItem('lockListViewMode', 'table')

      render(<LockListView isLoading={false} locks={[{ id: '1', token: 'USDC' }]} error={null} filters={{}} />)

      expect(screen.getByTestId('table-view')).toBeInTheDocument()
    })

    it('should persist card view toggle to localStorage', () => {
      localStorage.setItem('lockListViewMode', 'table')
      render(<LockListView isLoading={false} locks={[{ id: '1', token: 'USDC' }]} error={null} filters={{}} />)

      const cardViewButton = screen.getByText('Card')
      fireEvent.click(cardViewButton)

      expect(localStorage.getItem('lockListViewMode')).toBe('card')
    })

    it('should survive full component remount with persisted view mode', () => {
      const { unmount, rerender } = render(
        <LockListView isLoading={false} locks={[{ id: '1', token: 'USDC' }]} error={null} filters={{}} />
      )

      const tableViewButton = screen.getByText('Table')
      fireEvent.click(tableViewButton)

      unmount()

      render(<LockListView isLoading={false} locks={[{ id: '1', token: 'USDC' }]} error={null} filters={{}} />)

      expect(screen.getByTestId('table-view')).toBeInTheDocument()
    })
  })

  describe('locks display', () => {
    const mockLocks = [
      { id: '1', token: 'USDC', amount: '1000', beneficiary: 'addr1' },
      { id: '2', token: 'USDT', amount: '500', beneficiary: 'addr2' },
    ]

    it('should render locks list when locks exist', () => {
      render(<LockListView isLoading={false} locks={mockLocks} error={null} filters={{}} />)
      expect(screen.getByTestId('locks-list')).toBeInTheDocument()
    })

    it('should render correct number of lock items', () => {
      render(<LockListView isLoading={false} locks={mockLocks} error={null} filters={{}} />)
      const lockItems = screen.getAllByTestId('lock-item')
      expect(lockItems.length).toBe(2)
    })
  })
})
