with open('backend/src/test/java/com/manga/library/service/JobCoordinatorServiceTest.java', 'r') as f:
    content = f.read()

# Add mockGeneric back at the end of the class
content = content.replace('}\n', '''
  @SuppressWarnings("null")
  private <T> T mockGeneric(Class<?> clazz) {
    return (T) org.mockito.Mockito.mock(clazz);
  }
}
''', 1)

with open('backend/src/test/java/com/manga/library/service/JobCoordinatorServiceTest.java', 'w') as f:
    f.write(content)
