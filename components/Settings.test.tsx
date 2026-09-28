import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from './Settings'

const mockAddressBook = {
  add: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  export: jest.fn(() => JSON.stringify([])),
  import: jest.fn(),
  entries: [],
}

describe('Settings - Address Book', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Add form validation', () => {
    it('should block save with empty label', async () => {
      render(<Settings addressBook={mockAddressBook} />)

      const addressInput = screen.getByLabelText('Address')
      await userEvent.type(addressInput, 'GXXX...')

      const saveButton = screen.getByText('Add')
      fireEvent.click(saveButton)

      expect(mockAddressBook.add).not.toHaveBeenCalled()
      expect(screen.getByText(/Label is required/i)).toBeInTheDocument()
    })

    it('should block save with invalid address', async () => {
      render(<Settings addressBook={mockAddressBook} />)

      const labelInput = screen.getByLabelText('Label')
      const addressInput = screen.getByLabelText('Address')

      await userEvent.type(labelInput, 'My Address')
      await userEvent.type(addressInput, 'invalid-address')

      const saveButton = screen.getByText('Add')
      fireEvent.click(saveButton)

      expect(mockAddressBook.add).not.toHaveBeenCalled()
      expect(screen.getByText(/Invalid Stellar address/i)).toBeInTheDocument()
    })

    it('should call book.add with valid entry', async () => {
      render(<Settings addressBook={mockAddressBook} />)

      const labelInput = screen.getByLabelText('Label')
      const addressInput = screen.getByLabelText('Address')

      await userEvent.type(labelInput, 'My Address')
      await userEvent.type(addressInput, 'GXXX...')

      const saveButton = screen.getByText('Add')
      fireEvent.click(saveButton)

      expect(mockAddressBook.add).toHaveBeenCalledWith({
        label: 'My Address',
        address: 'GXXX...',
      })
    })

    it('should clear form after successful add', async () => {
      render(<Settings addressBook={mockAddressBook} />)

      const labelInput = screen.getByLabelText('Label') as HTMLInputElement
      const addressInput = screen.getByLabelText('Address') as HTMLInputElement

      await userEvent.type(labelInput, 'My Address')
      await userEvent.type(addressInput, 'GXXX...')

      const saveButton = screen.getByText('Add')
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(labelInput.value).toBe('')
        expect(addressInput.value).toBe('')
      })
    })
  })

  describe('Edit form validation', () => {
    it('should block save with empty label', async () => {
      const entry = { id: '1', label: 'Original', address: 'GXXX...' }
      render(<Settings addressBook={mockAddressBook} initialEditEntry={entry} />)

      const labelInput = screen.getByLabelText('Label') as HTMLInputElement
      labelInput.value = ''
      fireEvent.change(labelInput)

      const saveButton = screen.getByText('Update')
      fireEvent.click(saveButton)

      expect(mockAddressBook.update).not.toHaveBeenCalled()
      expect(screen.getByText(/Label is required/i)).toBeInTheDocument()
    })

    it('should block save with invalid address', async () => {
      const entry = { id: '1', label: 'Original', address: 'GXXX...' }
      render(<Settings addressBook={mockAddressBook} initialEditEntry={entry} />)

      const addressInput = screen.getByLabelText('Address') as HTMLInputElement
      addressInput.value = 'invalid'
      fireEvent.change(addressInput)

      const saveButton = screen.getByText('Update')
      fireEvent.click(saveButton)

      expect(mockAddressBook.update).not.toHaveBeenCalled()
      expect(screen.getByText(/Invalid Stellar address/i)).toBeInTheDocument()
    })

    it('should call book.update with valid entry', async () => {
      const entry = { id: '1', label: 'Original', address: 'GXXX...' }
      render(<Settings addressBook={mockAddressBook} initialEditEntry={entry} />)

      const labelInput = screen.getByLabelText('Label') as HTMLInputElement
      labelInput.value = 'Updated Label'
      fireEvent.change(labelInput)

      const saveButton = screen.getByText('Update')
      fireEvent.click(saveButton)

      expect(mockAddressBook.update).toHaveBeenCalledWith('1', {
        label: 'Updated Label',
        address: 'GXXX...',
      })
    })

    it('should clear form after successful update', async () => {
      const entry = { id: '1', label: 'Original', address: 'GXXX...' }
      render(<Settings addressBook={mockAddressBook} initialEditEntry={entry} />)

      const labelInput = screen.getByLabelText('Label') as HTMLInputElement
      labelInput.value = 'Updated'
      fireEvent.change(labelInput)

      const saveButton = screen.getByText('Update')
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(labelInput.value).toBe('')
      })
    })
  })

  describe('JSON import/export', () => {
    it('should export address book as JSON', () => {
      const entries = [
        { id: '1', label: 'Address 1', address: 'GXXX...' },
        { id: '2', label: 'Address 2', address: 'GYYY...' },
      ]
      mockAddressBook.export.mockReturnValue(JSON.stringify(entries))

      render(<Settings addressBook={mockAddressBook} />)

      const exportButton = screen.getByText('Export')
      fireEvent.click(exportButton)

      expect(mockAddressBook.export).toHaveBeenCalled()
    })

    it('should handle valid JSON import successfully', async () => {
      render(<Settings addressBook={mockAddressBook} />)

      const validJson = [
        { label: 'Imported 1', address: 'GXXX...' },
        { label: 'Imported 2', address: 'GYYY...' },
      ]

      mockAddressBook.import.mockReturnValue({ imported: 2, failed: 0 })

      const importButton = screen.getByText('Import')
      fireEvent.click(importButton)

      // Simulate file selection
      const fileInput = screen.getByLabelText('Select file')
      fireEvent.change(fileInput, { target: { files: [new File([JSON.stringify(validJson)], 'addresses.json')] } })

      await waitFor(() => {
        expect(screen.getByText(/2 addresses imported/i)).toBeInTheDocument()
      })
    })

    it('should handle partially valid JSON import', async () => {
      render(<Settings addressBook={mockAddressBook} />)

      mockAddressBook.import.mockReturnValue({ imported: 1, failed: 1 })

      const importButton = screen.getByText('Import')
      fireEvent.click(importButton)

      const fileInput = screen.getByLabelText('Select file')
      fireEvent.change(fileInput, { target: { files: [new File(['{}'], 'addresses.json')] } })

      await waitFor(() => {
        expect(screen.getByText(/1 imported.*1 failed/i)).toBeInTheDocument()
      })
    })

    it('should handle all-invalid JSON import', async () => {
      render(<Settings addressBook={mockAddressBook} />)

      mockAddressBook.import.mockReturnValue({ imported: 0, failed: 2 })

      const importButton = screen.getByText('Import')
      fireEvent.click(importButton)

      const fileInput = screen.getByLabelText('Select file')
      fireEvent.change(fileInput, { target: { files: [new File(['invalid'], 'addresses.json')] } })

      await waitFor(() => {
        expect(screen.getByText(/0 addresses imported.*2 failed/i)).toBeInTheDocument()
      })
    })
  })
})
