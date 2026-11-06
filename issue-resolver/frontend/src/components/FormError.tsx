interface FormErrorProps {
  message: string | null | undefined;
  className?: string;
}

const DEFAULT_CLASS = 'text-sm font-medium text-[#FF0033]';

export default function FormError({ message, className }: FormErrorProps) {
  if (!message) return null;
  return (
    <p role="alert" className={className ?? DEFAULT_CLASS}>
      {message}
    </p>
  );
}