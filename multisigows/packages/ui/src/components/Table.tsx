import React, { forwardRef } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '../theme/tokens';

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  wrapperClassName?: string;
}

export const Table = forwardRef<HTMLTableElement, TableProps>(
  ({ className, wrapperClassName, children, ...props }, ref) => {
    return (
      <div className={cn('relative w-full overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60', wrapperClassName)}>
        <table
          ref={ref}
          className={cn('w-full caption-bottom text-left border-collapse text-sm', className)}
          {...props}
        >
          {children}
        </table>
      </div>
    );
  }
);
Table.displayName = 'Table';

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      'border-b border-slate-800/90 bg-slate-950/60 text-xs uppercase tracking-wider text-slate-400 font-medium select-none',
      className
    )}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn('divide-y divide-slate-800/60 [&_tr:last-child]:border-0', className)}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

export interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  isInteractive?: boolean;
}

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, isInteractive = true, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'transition-colors duration-100',
        isInteractive && 'hover:bg-slate-800/40 cursor-pointer',
        className
      )}
      {...props}
    />
  )
);
TableRow.displayName = 'TableRow';

export const TableHead = forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn('h-11 px-4 text-left align-middle font-medium text-slate-400 text-xs', className)}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

export const TableCell = forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn('p-4 align-middle text-slate-200 text-sm font-normal', className)}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

export interface TableEmptyProps extends React.HTMLAttributes<HTMLTableRowElement> {
  colSpan: number;
  message?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
}

export const TableEmpty: React.FC<TableEmptyProps> = ({
  colSpan,
  message = 'No data available',
  description,
  icon,
  className,
  ...props
}) => (
  <tr className={cn('hover:bg-transparent', className)} {...props}>
    <td colSpan={colSpan} className="py-12 text-center">
      <div className="flex flex-col items-center justify-center space-y-2 text-slate-400">
        <div className="p-3 bg-slate-800/50 rounded-full text-slate-500">
          {icon || <Inbox className="w-6 h-6" />}
        </div>
        <div className="text-sm font-medium text-slate-300">{message}</div>
        {description && <div className="text-xs text-slate-500 max-w-sm">{description}</div>}
      </div>
    </td>
  </tr>
);
