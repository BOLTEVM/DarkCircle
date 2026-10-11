import React, { useState, useRef, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../theme/tokens';

export interface DropdownItem {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
}

export interface DropdownProps {
  trigger: React.ReactNode;
  items: DropdownItem[];
  align?: 'left' | 'right';
  className?: string;
  menuClassName?: string;
  onSelect?: (id: string) => void;
}

export const Dropdown: React.FC<DropdownProps> = ({
  trigger,
  items,
  align = 'left',
  className,
  menuClassName,
  onSelect,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => setIsOpen(false), []);

  const handleClickOutside = useCallback(
    (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        handleClose();
      }
    },
    [handleClose]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (isOpen && event.key === 'Escape') {
        handleClose();
      }
    },
    [isOpen, handleClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, handleClickOutside, handleKeyDown]);

  const handleItemClick = (item: DropdownItem) => {
    if (item.disabled) return;
    item.onClick?.();
    onSelect?.(item.id);
    handleClose();
  };

  return (
    <div ref={containerRef} className={cn('relative inline-block text-left', className)}>
      {/* Trigger Button Wrapper */}
      <div
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className="cursor-pointer inline-flex"
      >
        {trigger}
      </div>

      {/* Popover Menu */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -5 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -5 }}
            transition={{ duration: 0.12 }}
            className={cn(
              'absolute z-50 mt-1.5 w-60 rounded-xl bg-slate-900 border border-slate-800/90 shadow-2xl p-1.5 overflow-hidden',
              align === 'right' ? 'right-0' : 'left-0',
              menuClassName
            )}
            role="menu"
            aria-orientation="vertical"
          >
            <div className="space-y-0.5">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => handleItemClick(item)}
                  role="menuitem"
                  className={cn(
                    'w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg text-left transition-colors',
                    item.danger
                      ? 'text-rose-400 hover:bg-rose-500/10 hover:text-rose-300'
                      : 'text-slate-200 hover:bg-slate-800 hover:text-white',
                    item.disabled && 'opacity-40 cursor-not-allowed pointer-events-none'
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {item.icon && <span className="shrink-0 text-slate-400">{item.icon}</span>}
                    <div className="flex flex-col min-w-0">
                      <span className="truncate">{item.label}</span>
                      {item.description && (
                        <span className="text-[11px] text-slate-500 truncate">
                          {item.description}
                        </span>
                      )}
                    </div>
                  </div>
                  {item.badge && <div className="shrink-0 ml-2">{item.badge}</div>}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
