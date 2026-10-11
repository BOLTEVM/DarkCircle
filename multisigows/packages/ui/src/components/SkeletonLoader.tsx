import React from 'react';
import { cn } from '../theme/tokens';

export type SkeletonVariant =
  | 'text'
  | 'avatar'
  | 'card'
  | 'table-row'
  | 'button'
  | 'badge'
  | 'rect';

export interface SkeletonLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant;
  width?: string | number;
  height?: string | number;
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'full';
  count?: number;
}

const radiusStyles = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-xl',
  full: 'rounded-full',
};

export const SkeletonLoader: React.FC<SkeletonLoaderProps> = ({
  variant = 'rect',
  width,
  height,
  radius = 'md',
  count = 1,
  className,
  style,
  ...props
}) => {
  const getVariantStyles = (): string => {
    switch (variant) {
      case 'text':
        return 'h-4 w-3/4 rounded';
      case 'avatar':
        return 'h-10 w-10 rounded-full';
      case 'button':
        return 'h-10 w-28 rounded-lg';
      case 'badge':
        return 'h-6 w-16 rounded-md';
      case 'card':
        return 'h-36 w-full rounded-xl border border-slate-800';
      case 'table-row':
        return 'h-12 w-full rounded-none';
      case 'rect':
      default:
        return 'h-6 w-full rounded-md';
    }
  };

  const inlineStyles: React.CSSProperties = {
    ...style,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };

  const elements = Array.from({ length: count });

  if (count === 1) {
    return (
      <div
        role="status"
        aria-label="Loading..."
        className={cn(
          'animate-pulse bg-slate-800/60 transition-colors',
          radius && radiusStyles[radius],
          getVariantStyles(),
          className
        )}
        style={inlineStyles}
        {...props}
      />
    );
  }

  return (
    <div className="space-y-2.5 w-full" role="status" aria-label="Loading multiple items...">
      {elements.map((_, index) => (
        <div
          key={index}
          className={cn(
            'animate-pulse bg-slate-800/60 transition-colors',
            radius && radiusStyles[radius],
            getVariantStyles(),
            className
          )}
          style={inlineStyles}
          {...props}
        />
      ))}
    </div>
  );
};
