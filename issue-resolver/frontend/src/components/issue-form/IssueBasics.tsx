import type { Tag } from '@issue-resolver/shared';
import FilePicker from '../FilePicker';
import MarkdownEditor from '../MarkdownEditor';
import { inputClass, labelClass } from '../formStyles';

interface IssueBasicsProps {
  title: string;
  onTitleChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  tags: Tag[];
  onSelectTag: (tagId: string) => void;
  showFiles: boolean;
  files: File[];
  onFilesChange: (files: File[]) => void;
}

export default function IssueBasics({
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  tags,
  onSelectTag,
  showFiles,
  files,
  onFilesChange,
}: IssueBasicsProps) {
  return (
    <>
      <div>
        <label className={labelClass} htmlFor="title">
          Заголовок
        </label>
        <input
          id="title"
          className={inputClass}
          type="text"
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="Коротко о задаче"
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="additional_context">
          Описание задачи
        </label>
        <MarkdownEditor
          id="additional_context"
          value={description}
          onChange={onDescriptionChange}
          placeholder="Опишите, что нужно сделать"
          aria-label="Описание задачи"
          minHeight="6rem"
        />
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
          Теги
        </legend>
        <select
          id="issue-tag"
          data-testid="issue-tag-select"
          aria-label="Тег"
          className={inputClass}
          value=""
          onChange={(event) => onSelectTag(event.target.value)}
        >
          <option value="">Выберите тег (добавит все его репозитории)</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </fieldset>

      {showFiles && (
        <FilePicker id="issue-files" files={files} onChange={onFilesChange} />
      )}
    </>
  );
}