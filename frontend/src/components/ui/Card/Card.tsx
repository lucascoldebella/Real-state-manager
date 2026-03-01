import React from 'react';
import styles from './Card.module.css';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  noPadding?: boolean;
}

export const Card: React.FC<CardProps> = ({ children, className = '', noPadding = false, ...props }) => {
  return (
    <div className={`card-surface ${styles.card} ${noPadding ? styles.noPadding : ''} ${className}`} {...props}>
      {children}
    </div>
  );
};
