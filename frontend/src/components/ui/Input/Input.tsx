import React from 'react';
import styles from './Input.module.css';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export const Input: React.FC<InputProps> = ({ label, error, className = '', id, ...props }) => {
  const inputId = id || label.replace(/\s+/g, '-').toLowerCase();
  
  return (
    <div className={`${styles.wrapper} ${className}`}>
      <div className={styles.inputContainer}>
        <input 
          id={inputId}
          className={`${styles.input} ${error ? styles.hasError : ''}`} 
          placeholder=" "
          {...props} 
        />
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      </div>
      {error && <span className={styles.errorText}>{error}</span>}
    </div>
  );
};
