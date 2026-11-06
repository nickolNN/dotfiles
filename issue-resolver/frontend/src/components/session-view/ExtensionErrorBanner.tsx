import ErrorAlert from '../ErrorAlert';

export default function ExtensionErrorBanner({ message }: { message: string }) {
  return (
    <ErrorAlert testId="session-extension-error">
      Ошибка расширения: {message}
    </ErrorAlert>
  );
}